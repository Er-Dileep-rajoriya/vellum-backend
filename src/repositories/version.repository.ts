import { prisma } from "@/database/client.js";
import type { Prisma } from "@/generated/prisma/client.js";
import type { VersionKind } from "@/generated/prisma/enums.js";
import { accessRepository } from "@/repositories/access.repository.js";
import type { Actor } from "@/types/actor.js";
import { MAX_SNAPSHOT_BYTES } from "@/constants/limits.js";
import { badRequest, notFound, payloadTooLarge } from "@/utils/errors.js";

/**
 * Version history.
 *
 * Two things about this repository are unusual, and both are deliberate:
 *
 * **1. There is no `update`. There is no `delete`.** Not "we don't call them" — they do not exist, and
 * the database would refuse them anyway (a trigger rejects UPDATE and DELETE on `versions`; see the
 * `immutable_history` migration). Restore is the one feature where a careless implementation quietly
 * rewrites the past, and the cheapest way to make that impossible is to make it impossible.
 *
 * **2. The snapshot content is computed by the CLIENT, not here.** The server does not run the CRDT
 * (D-001), so it cannot fold an operation log into a document. It stores what the client uploads,
 * alongside the `serverSeq` watermark that content claims to represent.
 *
 * That sounds alarming, so state the threat model precisely: a malicious client can upload a snapshot
 * whose content does not match the log. What does that get them? Snapshots are a **cache**, never a
 * source of truth — the operation log is authoritative, every snapshot is rebuildable from it by
 * replay, and any client can detect a bad one. So the attack is: poison a bootstrap cache, be caught
 * by the first replica that replays the log. They cannot alter what the log says, and the log is what
 * everyone converges to.
 */

export interface VersionSummary {
  id: string;
  kind: VersionKind;
  label: string | null;
  description: string | null;
  serverSeq: string;
  authorId: string;
  authorName: string | null;
  parentVersionId: string | null;
  blockCount: number;
  charCount: number;
  createdAt: string;
}

export interface VersionDetail extends VersionSummary {
  content: unknown;
}

const SUMMARY_SELECT = {
  id: true,
  kind: true,
  label: true,
  description: true,
  serverSeq: true,
  authorId: true,
  parentVersionId: true,
  blockCount: true,
  charCount: true,
  createdAt: true,
  author: { select: { name: true } },
} as const;

type SummaryRow = {
  id: string;
  kind: VersionKind;
  label: string | null;
  description: string | null;
  serverSeq: bigint;
  authorId: string;
  parentVersionId: string | null;
  blockCount: number;
  charCount: number;
  createdAt: Date;
  author: { name: string | null };
};

function toSummary(row: SummaryRow): VersionSummary {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    description: row.description,
    serverSeq: row.serverSeq.toString(),
    authorId: row.authorId,
    authorName: row.author.name,
    parentVersionId: row.parentVersionId,
    blockCount: row.blockCount,
    charCount: row.charCount,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface CreateVersionInput {
  kind: VersionKind;
  label?: string | undefined;
  description?: string | undefined;
  content: unknown;
  serverSeq: bigint;
  blockCount: number;
  charCount: number;
  parentVersionId?: string | undefined;
}

export const versionRepository = {
  /** The timeline. Newest first, and it never folds an operation log — the stats are denormalised. */
  async list(actor: Actor, documentId: string, limit = 50): Promise<VersionSummary[]> {
    await accessRepository.authorize(actor, documentId, "read");

    const rows = await prisma.version.findMany({
      where: { documentId },
      orderBy: { serverSeq: "desc" },
      take: limit,
      select: SUMMARY_SELECT,
    });

    return rows.map(toSummary);
  },

  /** One version, with its content — for preview and for diffing. */
  async get(actor: Actor, documentId: string, versionId: string): Promise<VersionDetail> {
    await accessRepository.authorize(actor, documentId, "read");

    const row = await prisma.version.findFirst({
      where: { id: versionId, documentId },
      select: { ...SUMMARY_SELECT, content: true },
    });
    if (row === null) throw notFound("version");

    return { ...toSummary(row), content: row.content };
  },

  /**
   * Write a version.
   *
   * `AUTO` and `NAMED` snapshots require `write` (they record a state you authored). `RESTORE` requires
   * `restore` — which a VIEWER does not have, and which is checked here rather than in the route, so a
   * future second caller cannot forget it.
   */
  async create(
    actor: Actor,
    documentId: string,
    input: CreateVersionInput,
  ): Promise<VersionSummary> {
    await accessRepository.authorize(
      actor,
      documentId,
      input.kind === "RESTORE" ? "restore" : "write",
    );

    if (input.kind === "NAMED" && (input.label === undefined || input.label.trim() === "")) {
      throw badRequest("a named version requires a label");
    }

    // Snapshots are the one payload that can legitimately be large, so they get their own cap — checked
    // here as well as at the request boundary, because this method is also reachable from the WebSocket
    // path where Fastify's body limit does not apply.
    const size = JSON.stringify(input.content).length;
    if (size > MAX_SNAPSHOT_BYTES) {
      throw payloadTooLarge("snapshot exceeds the maximum size", { size, max: MAX_SNAPSHOT_BYTES });
    }

    const document = await prisma.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { serverSeq: true },
    });
    if (document === null) throw notFound("document");

    // A snapshot claiming to represent a position the document has never reached is either a bug or a
    // forgery. Either way it must not be stored: a snapshot with a watermark ahead of the log would make
    // every future client skip the operations between them.
    if (input.serverSeq > document.serverSeq) {
      throw badRequest("snapshot watermark is ahead of the document's committed sequence");
    }

    const version = await prisma.$transaction(async (tx) => {
      const created = await tx.version.create({
        data: {
          documentId,
          authorId: actor.userId,
          kind: input.kind,
          label: input.label ?? null,
          description: input.description ?? null,
          content: input.content as Prisma.InputJsonValue,
          serverSeq: input.serverSeq,
          blockCount: input.blockCount,
          charCount: input.charCount,
          parentVersionId: input.parentVersionId ?? null,
        },
        select: SUMMARY_SELECT,
      });

      /**
       * Advance the compaction watermark.
       *
       * `snapshotSeq` is what lets a new client bootstrap in O(1): fetch this snapshot, then pull only
       * the operations after it. Without it, opening a document with 200,000 operations means replaying
       * 200,000 operations.
       *
       * It only ever moves FORWARD (`GREATEST`). A snapshot uploaded late — a client that was offline
       * when it computed it — must never drag the watermark backwards, or clients that have already
       * discarded older operations would be told to fetch them again.
       */
      await tx.$executeRaw`
        UPDATE documents
        SET "snapshotSeq" = GREATEST("snapshotSeq", ${input.serverSeq})
        WHERE id = ${documentId}
      `;

      await tx.auditLog.create({
        data: {
          action: input.kind === "RESTORE" ? "VERSION_RESTORED" : "VERSION_CREATED",
          actorId: actor.userId,
          targetId: documentId,
          metadata: {
            versionId: created.id,
            kind: input.kind,
            ...(input.parentVersionId !== undefined
              ? { restoredFrom: input.parentVersionId }
              : {}),
          },
        },
      });

      return created;
    });

    return toSummary(version);
  },

  /**
   * The newest snapshot at or below the document's watermark — the bootstrap payload for a new client.
   */
  async latestSnapshot(actor: Actor, documentId: string): Promise<VersionDetail | null> {
    await accessRepository.authorize(actor, documentId, "read");

    const row = await prisma.version.findFirst({
      where: { documentId },
      orderBy: { serverSeq: "desc" },
      select: { ...SUMMARY_SELECT, content: true },
    });

    return row === null ? null : { ...toSummary(row), content: row.content };
  },
} as const;
