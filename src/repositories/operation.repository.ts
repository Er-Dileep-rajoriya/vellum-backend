import { prisma, withDocumentLock } from "@/database/client.js";
import type { Prisma } from "@/generated/prisma/client.js";
import type { OperationType } from "@/generated/prisma/enums.js";
import type { Actor } from "@/types/actor.js";
import type { IncomingOperation } from "@/validators/operation.validator.js";
import { DEFAULT_PULL_LIMIT, MAX_PULL_LIMIT } from "@/constants/limits.js";
import { gone, notFound } from "@/utils/errors.js";

/**
 * A committed operation, as it goes back to the client and out over the WebSocket.
 * `serverSeq` is serialised as a string: it is a Postgres bigint, and JSON numbers lose precision
 * above 2^53. A sync cursor that silently rounds is a sync cursor that silently skips operations.
 */
export interface CommittedOperation {
  operationId: string;
  documentId: string;
  userId: string;
  clientId: string;
  serverSeq: string;
  logicalClock: number;
  timestamp: string;
  documentVersion: string;
  operationType: OperationType;
  payload: unknown;
}

export interface CommitResult {
  /** Every operation in the batch, committed or already-present, with its authoritative serverSeq. */
  acknowledged: CommittedOperation[];
  /** Operations that were already committed by an earlier attempt. Purely informational. */
  duplicateCount: number;
  /** The document's serverSeq after this commit. The client's new checkpoint. */
  documentSeq: string;
}

const OPERATION_SELECT = {
  operationId: true,
  documentId: true,
  userId: true,
  clientId: true,
  serverSeq: true,
  logicalClock: true,
  timestamp: true,
  documentVersion: true,
  operationType: true,
  payload: true,
} as const satisfies Prisma.OperationSelect;

type OperationRow = {
  operationId: string;
  documentId: string;
  userId: string;
  clientId: string;
  serverSeq: bigint;
  logicalClock: number;
  timestamp: Date;
  documentVersion: bigint;
  operationType: OperationType;
  payload: Prisma.JsonValue;
};

function toWire(row: OperationRow): CommittedOperation {
  return {
    operationId: row.operationId,
    documentId: row.documentId,
    userId: row.userId,
    clientId: row.clientId,
    serverSeq: row.serverSeq.toString(),
    logicalClock: row.logicalClock,
    timestamp: row.timestamp.toISOString(),
    documentVersion: row.documentVersion.toString(),
    operationType: row.operationType,
    payload: row.payload,
  };
}

export const operationRepository = {
  /**
   * Commit a batch of operations to a document.
   *
   * This is the only write path into the operation log — HTTP push and the WebSocket relay both
   * call it, so there is exactly one commit pipeline in the system rather than two that drift.
   *
   * The transaction does four things, in this order, and the order is not negotiable:
   *
   *  1. **Take the document's advisory lock.** Sequence assignment is a read-modify-write of
   *     `documents.serverSeq`, and two concurrent pushes to the same document that both read
   *     `serverSeq = 41` will both write `42`. The unique constraint on (documentId, serverSeq)
   *     turns that into a crash rather than corruption — but a crash on every concurrent edit is
   *     not a product. The advisory lock serialises the read-modify-write per document, and *only*
   *     per document: pushes to different documents never contend. It is released when the
   *     transaction ends, including if it aborts, so there is no path that leaks it.
   *
   *     (Why not a Postgres SEQUENCE? Because sequences are explicitly *not* gapless — they hand
   *     out numbers to transactions that then roll back, leaving holes. A hole in the sync cursor
   *     means a client waiting forever for an operation that will never arrive.)
   *
   *  2. **Filter out operations already committed.** A retry after a network timeout re-sends
   *     operations that in fact landed. Those are not errors: they are the *success* path, and the
   *     client needs their original serverSeq to advance its checkpoint. We return them exactly as
   *     if they had just been written.
   *
   *  3. **Assign sequence numbers and insert.**
   *
   *  4. **Advance the document's counter** in the same transaction. If the process is killed
   *     between the insert and the counter update, the whole thing rolls back — a partially
   *     committed batch is impossible, so a client never sees a document whose counter disagrees
   *     with its log.
   *
   * `userId` comes from the Actor (i.e. from a verified token), never from the operation body.
   * The client cannot author an operation as somebody else.
   */
  async commitBatch(
    actor: Actor,
    documentId: string,
    operations: readonly IncomingOperation[],
  ): Promise<CommitResult> {
    return prisma.$transaction(async (tx) => {
      return withDocumentLock(tx, documentId, async () => {
        const document = await tx.document.findFirst({
          where: { id: documentId, deletedAt: null },
          select: { serverSeq: true },
        });

        // Authorization already ran before we got here, but the document could have been
        // soft-deleted between that check and this lock. Re-checking inside the lock is what makes
        // the guarantee real rather than probabilistic.
        if (document === null) throw notFound("document");

        const incomingIds = operations.map((op) => op.operationId);

        const alreadyCommitted = await tx.operation.findMany({
          where: { operationId: { in: incomingIds } },
          select: OPERATION_SELECT,
        });
        const committedById = new Map(alreadyCommitted.map((row) => [row.operationId, row]));

        const fresh = operations.filter((op) => !committedById.has(op.operationId));

        let nextSeq = document.serverSeq;
        const rows = fresh.map((op) => {
          nextSeq += 1n;
          return {
            operationId: op.operationId,
            documentId,
            userId: actor.userId,
            clientId: op.clientId,
            serverSeq: nextSeq,
            logicalClock: op.logicalClock,
            timestamp: op.timestamp,
            documentVersion: op.documentVersion,
            operationType: op.operationType,
            payload: op.payload,
          };
        });

        if (rows.length > 0) {
          await tx.operation.createMany({ data: rows });
          await tx.document.update({
            where: { id: documentId },
            data: { serverSeq: nextSeq, updatedAt: new Date() },
          });
        }

        // Acknowledge in the client's original order, not in commit order. The client matches acks
        // against its outbox by operationId, but a stable order makes the wire log readable and the
        // tests deterministic — and determinism in a sync protocol is worth more than the two lines
        // it costs here.
        const freshById = new Map(rows.map((row) => [row.operationId, row]));
        const acknowledged = operations.map((op) => {
          const committed = committedById.get(op.operationId);
          if (committed !== undefined) return toWire(committed);

          const inserted = freshById.get(op.operationId);
          /* c8 ignore next -- structurally impossible: every op is either already committed or freshly inserted */
          if (inserted === undefined) throw new Error(`unreachable: ${op.operationId} not committed`);
          return toWire({ ...inserted, payload: inserted.payload });
        });

        return {
          acknowledged,
          duplicateCount: committedById.size,
          documentSeq: nextSeq.toString(),
        };
      });
    });
  },

  /**
   * Read operations after a cursor.
   *
   * `since` is exclusive, so a client that has seen up to seq 40 asks for `since=40` and gets 41+.
   * An inclusive cursor would re-deliver one operation on every poll — harmless (operations are
   * idempotent) but wasteful, and it would mask an off-by-one in the client's checkpoint advance.
   *
   * If the cursor has fallen below the compaction watermark, the operations it wants are no longer
   * shipped and the honest answer is 410 Gone plus "bootstrap from the snapshot" — not a silently
   * incomplete page, which would leave the client permanently, invisibly missing history.
   */
  async pull(
    actor: Actor,
    documentId: string,
    since: bigint,
    limit: number = DEFAULT_PULL_LIMIT,
  ): Promise<{ operations: CommittedOperation[]; hasMore: boolean; documentSeq: string }> {
    const document = await prisma.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { serverSeq: true, snapshotSeq: true },
    });
    if (document === null) throw notFound("document");

    // `since === 0` is a fresh client that will bootstrap from the snapshot anyway, so it is never
    // "behind" — only a client with a real, stale cursor can fall off the back of the log.
    if (since > 0n && since < document.snapshotSeq) {
      throw gone(document.snapshotSeq);
    }

    const take = Math.min(Math.max(limit, 1), MAX_PULL_LIMIT);

    // Fetch one extra row to answer `hasMore` without a second COUNT query against the largest
    // table in the database.
    const rows = await prisma.operation.findMany({
      where: { documentId, serverSeq: { gt: since } },
      orderBy: { serverSeq: "asc" },
      take: take + 1,
      select: OPERATION_SELECT,
    });

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;

    return {
      operations: page.map(toWire),
      hasMore,
      documentSeq: document.serverSeq.toString(),
    };
  },

  /** Operation count since a watermark. Drives the auto-version trigger (every N operations). */
  async countSince(documentId: string, since: bigint): Promise<number> {
    return prisma.operation.count({ where: { documentId, serverSeq: { gt: since } } });
  },

  /** The full operation range backing a snapshot fold. Used by version restore and diff. */
  async range(documentId: string, from: bigint, to: bigint): Promise<CommittedOperation[]> {
    const rows = await prisma.operation.findMany({
      where: { documentId, serverSeq: { gt: from, lte: to } },
      orderBy: { serverSeq: "asc" },
      select: OPERATION_SELECT,
    });
    return rows.map(toWire);
  },
} as const;
