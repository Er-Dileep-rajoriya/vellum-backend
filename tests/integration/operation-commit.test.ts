import { ulid } from "ulid";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/database/client.js";
import { operationRepository } from "@/repositories/operation.repository.js";
import type { Actor } from "@/types/actor.js";
import { isAppError } from "@/utils/errors.js";
import type { IncomingOperation } from "@/validators/operation.validator.js";

import { createDocument, createUser, migrateTestDatabase, resetDatabase } from "../helpers/db.js";

function textInsert(clientId: string, counter: number, value: string): IncomingOperation {
  return {
    operationId: ulid(),
    clientId,
    logicalClock: counter,
    timestamp: new Date(),
    documentVersion: 0n,
    operationType: "TEXT_INSERT",
    payload: {
      blockId: "block-1",
      charId: `${clientId}:${counter}`,
      originLeft: null,
      value,
    },
  };
}

describe("operation commit pipeline", () => {
  beforeAll(() => {
    migrateTestDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it("assigns gapless, monotonic sequence numbers", async () => {
    const owner = await createUser();
    const documentId = await createDocument(owner);

    const result = await operationRepository.commitBatch(owner, documentId, [
      textInsert("c1", 1, "H"),
      textInsert("c1", 2, "i"),
      textInsert("c1", 3, "!"),
    ]);

    expect(result.acknowledged.map((op) => op.serverSeq)).toEqual(["1", "2", "3"]);
    expect(result.documentSeq).toBe("3");
    expect(result.duplicateCount).toBe(0);
  });

  /**
   * Idempotency: the retry-after-timeout path.
   *
   * A client pushes, the response is lost to a dead network, and the client retries the identical
   * batch. It MUST get the original sequence numbers back and the server MUST NOT commit anything a
   * second time. Any other behaviour either duplicates the user's text or leaves the client unable
   * to advance its checkpoint — and the client cannot tell the difference between "the request
   * failed" and "the response was lost", so this path is not an edge case. It is *normal*.
   */
  it("is idempotent: replaying a batch returns the original acks and commits nothing new", async () => {
    const owner = await createUser();
    const documentId = await createDocument(owner);

    const batch = [textInsert("c1", 1, "a"), textInsert("c1", 2, "b")];

    const first = await operationRepository.commitBatch(owner, documentId, batch);
    const replay = await operationRepository.commitBatch(owner, documentId, batch);

    expect(replay.acknowledged.map((op) => op.serverSeq)).toEqual(
      first.acknowledged.map((op) => op.serverSeq),
    );
    expect(replay.duplicateCount).toBe(2);
    expect(replay.documentSeq).toBe("2");

    const total = await prisma.operation.count({ where: { documentId } });
    expect(total).toBe(2);
  });

  it("handles a partially-duplicated batch (client resent one op plus a new one)", async () => {
    const owner = await createUser();
    const documentId = await createDocument(owner);

    const first = textInsert("c1", 1, "a");
    await operationRepository.commitBatch(owner, documentId, [first]);

    const second = textInsert("c1", 2, "b");
    const result = await operationRepository.commitBatch(owner, documentId, [first, second]);

    expect(result.duplicateCount).toBe(1);
    expect(result.acknowledged.map((op) => op.serverSeq)).toEqual(["1", "2"]);
    expect(await prisma.operation.count({ where: { documentId } })).toBe(2);
  });

  /**
   * The concurrency test this whole design exists for.
   *
   * Twenty replicas push simultaneously. Without the advisory lock, several transactions read the
   * same `documents.serverSeq` and assign the same next value — the unique constraint then turns
   * the race into an exception, and the user's edit is lost or the request 500s. With it, the
   * read-modify-write serialises per document and every operation gets exactly one slot.
   *
   * The assertion is not "it didn't crash": it is that the resulting sequence is exactly
   * 1..N with no gaps and no duplicates. A gap means a client will wait forever for an operation
   * that does not exist; a duplicate means two operations claim the same position in history.
   */
  it("assigns a gapless sequence under 20 concurrent pushes", async () => {
    const owner = await createUser();
    const documentId = await createDocument(owner);

    const CONCURRENCY = 20;
    const OPS_PER_PUSH = 5;

    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, replica) =>
        operationRepository.commitBatch(
          owner,
          documentId,
          Array.from({ length: OPS_PER_PUSH }, (_, index) =>
            textInsert(`client-${replica}`, index + 1, "x"),
          ),
        ),
      ),
    );

    const rows = await prisma.operation.findMany({
      where: { documentId },
      orderBy: { serverSeq: "asc" },
      select: { serverSeq: true },
    });

    const expected = CONCURRENCY * OPS_PER_PUSH;
    expect(rows).toHaveLength(expected);

    const sequences = rows.map((row) => Number(row.serverSeq));
    expect(sequences).toEqual(Array.from({ length: expected }, (_, i) => i + 1));

    const document = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      select: { serverSeq: true },
    });
    expect(Number(document.serverSeq)).toBe(expected);
  });

  /**
   * Identity is taken from the token, never from the wire. There is no `userId` field on an
   * incoming operation *at all* (see the validator), so this test asserts the positive: whoever the
   * Actor is, that is who authored the row.
   */
  it("attributes operations to the authenticated actor", async () => {
    const owner = await createUser("Owner");
    const documentId = await createDocument(owner);

    await operationRepository.commitBatch(owner, documentId, [textInsert("c1", 1, "a")]);

    const row = await prisma.operation.findFirstOrThrow({ where: { documentId } });
    expect(row.userId).toBe(owner.userId);
  });

  describe("pull", () => {
    async function seed(owner: Actor, documentId: string, count: number): Promise<void> {
      await operationRepository.commitBatch(
        owner,
        documentId,
        Array.from({ length: count }, (_, i) => textInsert("c1", i + 1, "x")),
      );
    }

    it("uses an exclusive cursor: since=N returns N+1 onward", async () => {
      const owner = await createUser();
      const documentId = await createDocument(owner);
      await seed(owner, documentId, 5);

      const page = await operationRepository.pull(owner, documentId, 3n);

      expect(page.operations.map((op) => op.serverSeq)).toEqual(["4", "5"]);
      expect(page.hasMore).toBe(false);
      expect(page.documentSeq).toBe("5");
    });

    it("reports hasMore without a second count query", async () => {
      const owner = await createUser();
      const documentId = await createDocument(owner);
      await seed(owner, documentId, 10);

      const page = await operationRepository.pull(owner, documentId, 0n, 4);

      expect(page.operations).toHaveLength(4);
      expect(page.hasMore).toBe(true);
    });

    /**
     * A client whose cursor has fallen below the compaction watermark must be told to resync from a
     * snapshot (410 Gone), not handed a silently incomplete page. An incomplete page would leave it
     * permanently missing a slice of history with no error and no way to notice.
     */
    it("returns GONE when the cursor is below the snapshot watermark", async () => {
      const owner = await createUser();
      const documentId = await createDocument(owner);
      await seed(owner, documentId, 5);

      await prisma.document.update({
        where: { id: documentId },
        data: { snapshotSeq: 4n },
      });

      await expect(operationRepository.pull(owner, documentId, 2n)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === "GONE" && !error.retryable,
      );

      // A brand-new client (since=0) bootstraps from the snapshot and is never "behind".
      await expect(operationRepository.pull(owner, documentId, 0n)).resolves.toBeDefined();
    });
  });
});
