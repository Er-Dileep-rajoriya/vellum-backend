import { createHash } from "node:crypto";

import { prisma } from "@/database/client.js";
import type { Prisma } from "@/generated/prisma/client.js";
import { IDEMPOTENCY_TTL_MS } from "@/constants/limits.js";
import { AppError } from "@/utils/errors.js";

export interface StoredResponse {
  statusCode: number;
  body: unknown;
}

/**
 * Batch-level idempotency.
 *
 * Per-operation uniqueness (the PK on `operations.operationId`) already makes a double *commit*
 * impossible. So why this table?
 *
 * Because the client needs a stable *response*. Consider: a client pushes 50 operations, the server
 * commits them, and the response is lost to a dying LTE connection. The client cannot distinguish
 * "the request never arrived" from "the reply never came back", so it retries. Without this table
 * the retry re-derives the acks (correctly — they are idempotent), but any *side effect* attached to
 * the response would run twice, and the client would have no guarantee that the second response says
 * the same thing as the first one it never saw.
 *
 * With it: the same key returns the same bytes, forever (well, for 24h — a retry that outlives that
 * is a new request by any sane definition).
 *
 * The `requestHash` is the security-relevant part. A replay with the same key but a *different* body
 * is not a retry — it is a bug or an attack (an attacker who observes a key and reuses it to smuggle
 * different operations under an already-accepted identity). That is rejected with 422, loudly, and
 * never answered from cache.
 */
export const idempotencyRepository = {
  hashRequest(body: unknown): string {
    // Stable stringification is unnecessary here: the body is hashed exactly as the client sent it,
    // and a client that reorders its own JSON keys between retries has produced a different request.
    return createHash("sha256").update(JSON.stringify(body)).digest("hex");
  },

  /**
   * Returns a previously stored response for this key, or null if this is the first time we have
   * seen it. Throws IDEMPOTENCY_MISMATCH if the key is being reused with a different body.
   */
  async find(key: string, userId: string, requestHash: string): Promise<StoredResponse | null> {
    const record = await prisma.idempotencyKey.findUnique({
      where: { key },
      select: {
        userId: true,
        requestHash: true,
        response: true,
        statusCode: true,
        expiresAt: true,
      },
    });

    if (record === null) return null;

    // An expired record is treated as absent. The row is left for the GC sweep rather than deleted
    // here — a read path that writes is a read path that deadlocks under load.
    if (record.expiresAt.getTime() < Date.now()) return null;

    // Another user's key. Not "not found" — this is someone using a key that is not theirs, which is
    // never an accident, so it is a hard rejection and it should be visible in the logs.
    if (record.userId !== userId) {
      throw new AppError("IDEMPOTENCY_MISMATCH", "idempotency key belongs to another user");
    }

    if (record.requestHash !== requestHash) {
      throw new AppError(
        "IDEMPOTENCY_MISMATCH",
        "idempotency key was already used with a different request body",
      );
    }

    return { statusCode: record.statusCode, body: record.response };
  },

  /**
   * Store the response for this key.
   *
   * `create`, not `upsert`: if two concurrent requests carry the same key, exactly one wins the
   * insert and the other gets a unique violation — which the caller treats as "someone else got
   * there first, re-read their answer". Upserting would let the second request *overwrite* the
   * first's response, which defeats the entire purpose of the table.
   */
  async store(
    key: string,
    userId: string,
    route: string,
    requestHash: string,
    statusCode: number,
    body: unknown,
  ): Promise<void> {
    await prisma.idempotencyKey.create({
      data: {
        key,
        userId,
        route,
        requestHash,
        statusCode,
        response: body as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      },
    });
  },

  async collectGarbage(): Promise<number> {
    const { count } = await prisma.idempotencyKey.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return count;
  },
} as const;
