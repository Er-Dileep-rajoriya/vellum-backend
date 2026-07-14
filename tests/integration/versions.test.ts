import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/database/client.js";
import { operationRepository } from "@/repositories/operation.repository.js";
import { versionRepository } from "@/repositories/version.repository.js";
import type { Actor } from "@/types/actor.js";
import { isAppError } from "@/utils/errors.js";
import type { IncomingOperation } from "@/validators/operation.validator.js";
import { ulid } from "ulid";

import {
  addCollaborator,
  createDocument,
  createUser,
  migrateTestDatabase,
  resetDatabase,
} from "../helpers/db.js";

function op(clientId: string, counter: number): IncomingOperation {
  return {
    operationId: ulid(),
    clientId,
    logicalClock: counter,
    timestamp: new Date(),
    documentVersion: 0n,
    operationType: "TEXT_INSERT",
    payload: { blockId: "b1", charId: `${clientId}:${counter}`, originLeft: null, value: "x" },
  };
}

const CONTENT = { version: 1, blocks: [{ id: "b1", type: "paragraph", text: "hello" }] };

describe("version history", () => {
  beforeAll(() => {
    migrateTestDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  async function seed(actor: Actor, count = 3): Promise<string> {
    const documentId = await createDocument(actor);
    await operationRepository.commitBatch(
      actor,
      documentId,
      Array.from({ length: count }, (_, i) => op("c1", i + 1)),
    );
    return documentId;
  }

  it("creates a named version and advances the compaction watermark", async () => {
    const owner = await createUser();
    const documentId = await seed(owner);

    const version = await versionRepository.create(owner, documentId, {
      kind: "NAMED",
      label: "Before the rewrite",
      content: CONTENT,
      serverSeq: 3n,
      blockCount: 1,
      charCount: 5,
    });

    expect(version.label).toBe("Before the rewrite");
    expect(version.serverSeq).toBe("3");

    // `snapshotSeq` is what lets a new client bootstrap in O(1) — fetch this snapshot, pull only what
    // came after it — instead of replaying the document's entire history.
    const document = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      select: { snapshotSeq: true },
    });
    expect(document.snapshotSeq).toBe(3n);
  });

  it("never moves the watermark backwards", async () => {
    const owner = await createUser();
    const documentId = await seed(owner, 5);

    await versionRepository.create(owner, documentId, {
      kind: "AUTO",
      content: CONTENT,
      serverSeq: 5n,
      blockCount: 1,
      charCount: 5,
    });

    // A snapshot computed while the client was offline arrives late, claiming an OLDER watermark.
    // Accepting it would drag `snapshotSeq` backwards, and clients that have already discarded older
    // operations would be told to fetch them again — operations the server may no longer ship.
    await versionRepository.create(owner, documentId, {
      kind: "AUTO",
      content: CONTENT,
      serverSeq: 2n,
      blockCount: 1,
      charCount: 5,
    });

    const document = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      select: { snapshotSeq: true },
    });
    expect(document.snapshotSeq).toBe(5n); // GREATEST, not assignment
  });

  it("rejects a snapshot whose watermark is ahead of the log", async () => {
    const owner = await createUser();
    const documentId = await seed(owner, 2);

    // A snapshot claiming a position the document has never reached is a bug or a forgery. Storing it
    // would make every future client skip the operations between the log's head and this claim.
    await expect(
      versionRepository.create(owner, documentId, {
        kind: "AUTO",
        content: CONTENT,
        serverSeq: 99n,
        blockCount: 1,
        charCount: 5,
      }),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === "BAD_REQUEST");
  });

  it("requires a label for a NAMED version", async () => {
    const owner = await createUser();
    const documentId = await seed(owner);

    await expect(
      versionRepository.create(owner, documentId, {
        kind: "NAMED",
        content: CONTENT,
        serverSeq: 1n,
        blockCount: 1,
        charCount: 5,
      }),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === "BAD_REQUEST");
  });

  /**
   * The permission that matters. A VIEWER cannot restore — restoring writes operations into the
   * document, so allowing it would be allowing a viewer to edit, via a different button.
   */
  it("a VIEWER cannot create a RESTORE version", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const documentId = await seed(owner);
    await addCollaborator(documentId, viewer, "VIEWER");

    await expect(
      versionRepository.create(viewer, documentId, {
        kind: "RESTORE",
        content: CONTENT,
        serverSeq: 1n,
        blockCount: 1,
        charCount: 5,
      }),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === "FORBIDDEN");

    // A viewer cannot create an ordinary snapshot either — that is a write.
    await expect(
      versionRepository.create(viewer, documentId, {
        kind: "AUTO",
        content: CONTENT,
        serverSeq: 1n,
        blockCount: 1,
        charCount: 5,
      }),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === "FORBIDDEN");

    // ...but they can READ the history. Viewers view.
    await expect(versionRepository.list(viewer, documentId)).resolves.toBeDefined();
  });

  it("an EDITOR can restore", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const documentId = await seed(owner);
    await addCollaborator(documentId, editor, "EDITOR");

    const version = await versionRepository.create(editor, documentId, {
      kind: "RESTORE",
      content: CONTENT,
      serverSeq: 3n,
      blockCount: 1,
      charCount: 5,
    });

    expect(version.kind).toBe("RESTORE");
  });

  it("a restore links to its parent — history is a DAG, not a line", async () => {
    const owner = await createUser();
    const documentId = await seed(owner);

    const original = await versionRepository.create(owner, documentId, {
      kind: "NAMED",
      label: "v1",
      content: CONTENT,
      serverSeq: 1n,
      blockCount: 1,
      charCount: 5,
    });

    const restore = await versionRepository.create(owner, documentId, {
      kind: "RESTORE",
      content: CONTENT,
      serverSeq: 3n,
      blockCount: 1,
      charCount: 5,
      parentVersionId: original.id,
    });

    expect(restore.parentVersionId).toBe(original.id);

    const timeline = await versionRepository.list(owner, documentId);
    expect(timeline).toHaveLength(2);
    // The original is STILL THERE, unchanged. A restore appends; it does not consume what it restored.
    expect(timeline.map((version) => version.id)).toContain(original.id);
  });

  /**
   * The immutability guarantee, tested at the layer that actually enforces it.
   *
   * There is no `update` or `delete` in the repository — so the only way to test this is to go around
   * the repository and try it directly against the database. Which is precisely the threat: a future
   * "quick fix" endpoint, a migration script, a psql session at 2am.
   */
  it("the database itself refuses to mutate or delete a version", async () => {
    const owner = await createUser();
    const documentId = await seed(owner);

    const version = await versionRepository.create(owner, documentId, {
      kind: "NAMED",
      label: "immutable",
      content: CONTENT,
      serverSeq: 1n,
      blockCount: 1,
      charCount: 5,
    });

    await expect(
      prisma.$executeRaw`UPDATE versions SET label = 'tampered' WHERE id = ${version.id}`,
    ).rejects.toThrow(/append-only/);

    await expect(
      prisma.$executeRaw`DELETE FROM versions WHERE id = ${version.id}`,
    ).rejects.toThrow(/append-only/);

    const unchanged = await versionRepository.get(owner, documentId, version.id);
    expect(unchanged.label).toBe("immutable");
  });

  it("a stranger cannot read a document's history", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const documentId = await seed(owner);

    await expect(versionRepository.list(stranger, documentId)).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === "NOT_FOUND",
    );
  });
});
