import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { MAX_DESCRIPTION_LENGTH, MAX_LABEL_LENGTH } from "@/constants/limits.js";
import { actorOf, requireAuth } from "@/middlewares/auth.middleware.js";
import { actorRateLimit } from "@/middlewares/rateLimit.middleware.js";
import { versionRepository } from "@/repositories/version.repository.js";

/**
 * Version history.
 *
 * The `content` of a version is computed by the CLIENT (the server does not run the CRDT — D-001) and
 * uploaded here. The server stores it, records the watermark it claims, and refuses one that claims a
 * position the log has not reached.
 *
 * Note what is NOT here: a `PATCH /versions/:id` and a `DELETE /versions/:id`. They do not exist, at
 * any layer — not in the route, not in the repository, and the database would reject them anyway. A
 * restore appends; it never rewrites.
 */

const DocumentParams = z.object({ id: z.string().min(1).max(64) });

const CreateVersionBody = z
  .object({
    kind: z.enum(["AUTO", "NAMED", "RESTORE"]),
    label: z.string().trim().min(1).max(MAX_LABEL_LENGTH).optional(),
    description: z.string().trim().max(MAX_DESCRIPTION_LENGTH).optional(),
    /** The materialised CRDT snapshot. Shape is the client's; the server treats it as opaque JSON. */
    content: z.unknown(),
    serverSeq: z.coerce.bigint().nonnegative(),
    blockCount: z.number().int().nonnegative().max(100_000),
    charCount: z.number().int().nonnegative().max(50_000_000),
    /** Set on a RESTORE: which version was restored. Turns history into a DAG rather than a line. */
    parentVersionId: z.string().min(1).max(64).optional(),
  })
  .strict();

export async function versionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", actorRateLimit);

  app.get("/documents/:id/versions", async (request, reply) => {
    const actor = actorOf(request);
    const { id } = DocumentParams.parse(request.params);

    const versions = await versionRepository.list(actor, id);
    return reply.send({ versions });
  });

  app.get("/documents/:id/versions/:versionId", async (request, reply) => {
    const actor = actorOf(request);
    const params = DocumentParams.extend({ versionId: z.string().min(1).max(64) }).parse(
      request.params,
    );

    const version = await versionRepository.get(actor, params.id, params.versionId);
    return reply.send({ version });
  });

  /** The bootstrap payload for a new client: the newest snapshot, plus its watermark. */
  app.get("/documents/:id/snapshot", async (request, reply) => {
    const actor = actorOf(request);
    const { id } = DocumentParams.parse(request.params);

    const snapshot = await versionRepository.latestSnapshot(actor, id);
    return reply.send({ snapshot });
  });

  /**
   * Create a version.
   *
   * `kind: RESTORE` requires the `restore` permission — which a VIEWER does not have. The check lives in
   * the repository, not here, so a second caller (the WebSocket path, a future background job) cannot
   * forget it.
   */
  app.post("/documents/:id/versions", async (request, reply) => {
    const actor = actorOf(request);
    const { id } = DocumentParams.parse(request.params);
    const body = CreateVersionBody.parse(request.body);

    const version = await versionRepository.create(actor, id, {
      kind: body.kind,
      label: body.label,
      description: body.description,
      content: body.content,
      serverSeq: body.serverSeq,
      blockCount: body.blockCount,
      charCount: body.charCount,
      parentVersionId: body.parentVersionId,
    });

    return reply.status(201).send({ version });
  });
}
