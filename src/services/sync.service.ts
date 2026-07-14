import { prisma } from "@/database/client.js";
import type { FailureReason } from "@/generated/prisma/enums.js";
import type { Prisma } from "@/generated/prisma/client.js";
import { accessRepository } from "@/repositories/access.repository.js";
import { operationRepository, type CommittedOperation } from "@/repositories/operation.repository.js";
import { rateLimitRepository } from "@/repositories/rateLimit.repository.js";
import type { Actor } from "@/types/actor.js";
import { env } from "@/config/env.js";
import { RATE_LIMIT_WINDOW_MS } from "@/constants/limits.js";
import { isAppError, rateLimited, type AppError } from "@/utils/errors.js";
import { logger } from "@/utils/logger.js";
import type { PushRequest } from "@/validators/operation.validator.js";

export interface PushResult {
  acknowledged: CommittedOperation[];
  duplicateCount: number;
  documentSeq: string;
}

export interface PullResult {
  operations: CommittedOperation[];
  hasMore: boolean;
  documentSeq: string;
}

/**
 * The commit pipeline: validate → authorize → rate-limit → dedupe → sequence → persist → broadcast.
 *
 * Validation has already happened at the route boundary (zod, before this is called). What remains
 * is everything that needs the database.
 *
 * Both transports call this: the HTTP route handler and the WebSocket relay. That is the entire
 * reason it lives in a service rather than in a controller — two transports over one pipeline means
 * the WebSocket cannot become a way to bypass a check that HTTP enforces. (DECISIONS.md D-006: the
 * socket is an accelerator over the protocol, never a second protocol.)
 */

type Broadcaster = (documentId: string, operations: CommittedOperation[]) => void;

/**
 * The broadcast hook is injected rather than imported, so this service does not depend on the
 * WebSocket layer — the dependency points the other way. A service that imports its own transport is
 * a service you cannot test without standing up a socket server.
 */
let broadcast: Broadcaster = () => {};

export function setBroadcaster(fn: Broadcaster): void {
  broadcast = fn;
}

export const syncService = {
  async push(actor: Actor, request: PushRequest): Promise<PushResult> {
    const { documentId, operations } = request;

    // 1. Authorize. A VIEWER is rejected here, with 403. This is the single check that makes
    //    "viewers cannot sync" true — and note that it must live on the *push* path, not on some
    //    "edit" path, because for an offline-first client an edit IS a deferred push. A design that
    //    only blocks the editor UI lets a viewer edit offline and commit it hours later.
    await accessRepository.authorize(actor, documentId, "write");

    // 2. Rate-limit by *operation count*, not request count. A user can send one request with 500
    //    operations or 500 requests with one; the resource being protected is the write throughput of
    //    the database, so the budget must be denominated in the thing that costs.
    const verdict = await rateLimitRepository.consume(
      `ops:${actor.userId}`,
      env.RATE_LIMIT_OPS_PER_MINUTE,
      RATE_LIMIT_WINDOW_MS,
    );
    if (!verdict.allowed) {
      throw rateLimited(verdict.retryAfterSeconds);
    }

    // 3–5. Dedupe, sequence, persist — one transaction, one advisory lock, gapless.
    const result = await operationRepository.commitBatch(actor, documentId, operations);

    // 6. Broadcast to everyone else on the document. Fire-and-forget by design: a slow or dead
    //    WebSocket subscriber must never delay, and must never fail, a commit that is already durable
    //    in Postgres. A client that misses a broadcast is not broken — it will pull the operation on
    //    its next cursor poll, because the socket is an optimisation and the log is the truth.
    if (result.acknowledged.length > result.duplicateCount) {
      const fresh = result.acknowledged.slice(result.duplicateCount);
      broadcast(documentId, fresh);
    }

    // 7. Advance this replica's sync session (checkpoint + "last seen"). Deliberately after the
    //    commit and outside its transaction: session bookkeeping is telemetry, and telemetry must
    //    never be able to roll back a user's writes.
    void syncService
      .touchSession(actor, documentId, request.clientId, {
        lastPushedSeq: BigInt(result.documentSeq),
        opsPushed: operations.length,
      })
      .catch((error: unknown) => {
        logger.warn({ err: error, documentId }, "failed to update sync session after push");
      });

    return result;
  },

  async pull(
    actor: Actor,
    documentId: string,
    since: bigint,
    limit: number | undefined,
    clientId?: string,
  ): Promise<PullResult> {
    await accessRepository.authorize(actor, documentId, "read");

    const result = await operationRepository.pull(actor, documentId, since, limit);

    const newest = result.operations.at(-1);
    if (clientId !== undefined && newest !== undefined) {
      const highest = newest.serverSeq;
      void syncService
        .touchSession(actor, documentId, clientId, {
          lastAckedSeq: BigInt(highest),
          opsPulled: result.operations.length,
        })
        .catch((error: unknown) => {
          logger.warn({ err: error, documentId }, "failed to update sync session after pull");
        });
    }

    return result;
  },

  /**
   * Upsert the (document, client) sync session.
   *
   * `lastAckedSeq` is the compaction watermark input: operations below `min(lastAckedSeq)` across all
   * live sessions are safe to stop shipping. It is written with a `GREATEST` guard rather than a
   * plain assignment because pulls can complete out of order (two concurrent page fetches), and a
   * watermark that can move *backwards* would let compaction believe a client needs history it has
   * already discarded — or worse, let it advance past history a client still needs.
   */
  async touchSession(
    actor: Actor,
    documentId: string,
    clientId: string,
    update: { lastAckedSeq?: bigint; lastPushedSeq?: bigint; opsPushed?: number; opsPulled?: number },
  ): Promise<void> {
    const ackedSeq = update.lastAckedSeq ?? 0n;
    const pushedSeq = update.lastPushedSeq ?? 0n;
    const pushed = update.opsPushed ?? 0;
    const pulled = update.opsPulled ?? 0;

    await prisma.$executeRaw`
      INSERT INTO sync_sessions
        (id, "documentId", "userId", "clientId", "lastAckedSeq", "lastPushedSeq",
         "opsPushed", "opsPulled", "connectedAt", "lastSeenAt")
      VALUES
        (gen_random_uuid()::text, ${documentId}, ${actor.userId}, ${clientId}, ${ackedSeq},
         ${pushedSeq}, ${pushed}, ${pulled}, now(), now())
      ON CONFLICT ("documentId", "clientId") DO UPDATE SET
        "lastAckedSeq"  = GREATEST(sync_sessions."lastAckedSeq", EXCLUDED."lastAckedSeq"),
        "lastPushedSeq" = GREATEST(sync_sessions."lastPushedSeq", EXCLUDED."lastPushedSeq"),
        "opsPushed"     = sync_sessions."opsPushed" + EXCLUDED."opsPushed",
        "opsPulled"     = sync_sessions."opsPulled" + EXCLUDED."opsPulled",
        "lastSeenAt"    = now()
    `;
  },

  /**
   * Record an operation that can never succeed.
   *
   * This is the server half of the dead-letter queue. The client has its own, but a client-side DLQ
   * alone is a DLQ that vanishes when the user clears their browser data — and the operations in it
   * are, by definition, the ones we already failed to handle correctly.
   *
   * The rejected payload is stored verbatim. When a validation bug is fixed, these rows are what let
   * the writes be replayed instead of mourned.
   */
  async recordFailure(
    actor: Actor,
    documentId: string,
    clientId: string,
    operationId: string,
    error: AppError,
    payload: unknown,
  ): Promise<void> {
    const reason: FailureReason = isAppError(error)
      ? ({
          VALIDATION_FAILED: "VALIDATION_FAILED",
          BAD_REQUEST: "VALIDATION_FAILED",
          PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
          FORBIDDEN: "UNAUTHORIZED",
          UNAUTHENTICATED: "UNAUTHORIZED",
          NOT_FOUND: "DOCUMENT_DELETED",
          GONE: "CONFLICT",
          CONFLICT: "CONFLICT",
          IDEMPOTENCY_MISMATCH: "VALIDATION_FAILED",
          RATE_LIMITED: "RATE_LIMITED",
          INTERNAL: "INTERNAL",
        } as const)[error.code]
      : "INTERNAL";

    await prisma.failedOperation.create({
      data: {
        operationId,
        documentId,
        userId: actor.userId,
        clientId,
        reason,
        message: error.message,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  },

  /** The client's DLQ inspector reads this. Unresolved failures only. */
  async listFailures(actor: Actor, documentId: string) {
    await accessRepository.authorize(actor, documentId, "read");

    return prisma.failedOperation.findMany({
      where: { documentId, userId: actor.userId, resolvedAt: null },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        operationId: true,
        reason: true,
        message: true,
        payload: true,
        attempts: true,
        createdAt: true,
      },
    });
  },
} as const;
