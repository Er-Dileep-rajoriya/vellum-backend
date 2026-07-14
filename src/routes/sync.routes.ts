import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { actorOf, requireAuth } from "@/middlewares/auth.middleware.js";
import { actorRateLimit } from "@/middlewares/rateLimit.middleware.js";
import { idempotencyRepository } from "@/repositories/idempotency.repository.js";
import { syncService } from "@/services/sync.service.js";
import { badRequest } from "@/utils/errors.js";
import { PullQuerySchema, PushRequestSchema } from "@/validators/operation.validator.js";

/**
 * The sync protocol. Two endpoints, and everything else in the system is built on them.
 *
 *   POST /sync/push?  — commit a batch of operations. Idempotent.
 *   GET  /sync/pull   — read operations after a cursor.
 *
 * The WebSocket relay is an accelerator over exactly this protocol, not an alternative to it: if the
 * socket is blocked by a corporate proxy or the relay is down, the product still works over these
 * two routes. Sync latency degrades from ~50ms to the poll interval; correctness does not change at
 * all. (DECISIONS.md D-006.)
 */

const IdempotencyHeaderSchema = z.object({
  "idempotency-key": z
    .string()
    .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, { error: "Idempotency-Key must be a ULID" }),
});

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  // Order matters and is load-bearing: authenticate first, then apply the per-user budget. Hooks run
  // in registration order within a plugin, so `actorRateLimit` is guaranteed to see an Actor.
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", actorRateLimit);

  app.post("/sync/push", async (request, reply) => {
    const actor = actorOf(request);

    const headers = IdempotencyHeaderSchema.safeParse(request.headers);
    if (!headers.success) {
      // Required, not optional. An unkeyed push cannot be safely retried, and a sync client on a
      // flaky network *will* retry — so an API that lets the client omit the key is an API that
      // invites duplicate commits. Making it mandatory means the safe path is the only path.
      throw badRequest("Idempotency-Key header is required (a ULID) on /sync/push");
    }
    const key = headers.data["idempotency-key"];

    const body = PushRequestSchema.parse(request.body);
    const requestHash = idempotencyRepository.hashRequest(request.body);

    // Replay: identical key + identical body → the original response, byte for byte. Identical key +
    // *different* body → 422, because that is not a retry, it is either a bug or someone reusing a
    // key they observed.
    const replayed = await idempotencyRepository.find(key, actor.userId, requestHash);
    if (replayed !== null) {
      return reply.status(replayed.statusCode).send(replayed.body);
    }

    const result = await syncService.push(actor, body);
    const response = {
      acknowledged: result.acknowledged,
      duplicateCount: result.duplicateCount,
      documentSeq: result.documentSeq,
    };

    try {
      await idempotencyRepository.store(key, actor.userId, "/sync/push", requestHash, 200, response);
    } catch {
      // A unique violation here means a concurrent request with the same key won the race and stored
      // its (necessarily identical) response first. The commit itself is already idempotent, so
      // there is nothing to undo and nothing to report — both callers get the same answer, which is
      // the entire contract. Swallowing this is correct; failing the request would turn a
      // successfully committed batch into a client-visible error.
    }

    return reply.status(200).send(response);
  });

  app.get("/sync/pull", async (request, reply) => {
    const actor = actorOf(request);
    const query = PullQuerySchema.parse(request.query);
    const clientId =
      typeof request.headers["x-client-id"] === "string" ? request.headers["x-client-id"] : undefined;

    const result = await syncService.pull(
      actor,
      query.documentId,
      query.since,
      query.limit,
      clientId,
    );

    return reply.status(200).send(result);
  });

  /** The server-side dead-letter queue: operations that can never succeed, kept visible. */
  app.get("/sync/failures", async (request, reply) => {
    const actor = actorOf(request);
    const query = z.object({ documentId: z.string().min(1).max(64) }).parse(request.query);

    const failures = await syncService.listFailures(actor, query.documentId);
    return reply.status(200).send({ failures });
  });
}
