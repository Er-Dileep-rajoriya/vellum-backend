import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { MAX_TITLE_LENGTH } from "@/constants/limits.js";
import { actorOf, requireAuth } from "@/middlewares/auth.middleware.js";
import { actorRateLimit } from "@/middlewares/rateLimit.middleware.js";
import { collaboratorRepository } from "@/repositories/collaborator.repository.js";
import { documentRepository } from "@/repositories/document.repository.js";

const DocumentIdParams = z.object({ id: z.string().min(1).max(64) });
const TitleBody = z.object({ title: z.string().trim().min(1).max(MAX_TITLE_LENGTH) });
const RoleBody = z.object({ role: z.enum(["EDITOR", "VIEWER"]) });

/**
 * Document and collaborator management.
 *
 * Note the absence of an authorization check in every handler below: there isn't one, because there
 * cannot be one. The repositories take an `Actor` and enforce it themselves (D-011), so a route that
 * forgot to check permissions does not exist as a reachable state — the repository would refuse.
 * Authorization spread across controllers is authorization that will eventually be forgotten in one
 * of them.
 */
export async function documentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", actorRateLimit);

  app.get("/documents", async (request, reply) => {
    const actor = actorOf(request);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().min(1).max(64).optional(),
      })
      .parse(request.query);

    const documents = await documentRepository.listForActor(actor, query.limit, query.cursor);
    return reply.send({ documents });
  });

  app.post("/documents", async (request, reply) => {
    const actor = actorOf(request);
    const body = TitleBody.partial().parse(request.body ?? {});

    const document = await documentRepository.create(actor, body.title ?? "Untitled");
    return reply.status(201).send({ document });
  });

  app.get("/documents/:id", async (request, reply) => {
    const actor = actorOf(request);
    const { id } = DocumentIdParams.parse(request.params);

    const document = await documentRepository.findForActor(actor, id);
    return reply.send({ document });
  });

  app.patch("/documents/:id", async (request, reply) => {
    const actor = actorOf(request);
    const { id } = DocumentIdParams.parse(request.params);
    const { title } = TitleBody.parse(request.body);

    await documentRepository.rename(actor, id, title);
    return reply.status(204).send();
  });

  app.delete("/documents/:id", async (request, reply) => {
    const actor = actorOf(request);
    const { id } = DocumentIdParams.parse(request.params);

    await documentRepository.softDelete(actor, id);
    return reply.status(204).send();
  });

  app.post("/documents/:id/restore", async (request, reply) => {
    const actor = actorOf(request);
    const { id } = DocumentIdParams.parse(request.params);

    await documentRepository.restore(actor, id);
    return reply.status(204).send();
  });

  app.get("/documents/:id/collaborators", async (request, reply) => {
    const actor = actorOf(request);
    const { id } = DocumentIdParams.parse(request.params);

    const collaborators = await collaboratorRepository.list(actor, id);
    return reply.send({ collaborators });
  });

  app.patch("/documents/:id/collaborators/:userId", async (request, reply) => {
    const actor = actorOf(request);
    const params = DocumentIdParams.extend({ userId: z.string().min(1).max(64) }).parse(
      request.params,
    );
    const { role } = RoleBody.parse(request.body);

    await collaboratorRepository.changeRole(actor, params.id, params.userId, role);
    return reply.status(204).send();
  });

  app.delete("/documents/:id/collaborators/:userId", async (request, reply) => {
    const actor = actorOf(request);
    const params = DocumentIdParams.extend({ userId: z.string().min(1).max(64) }).parse(
      request.params,
    );

    await collaboratorRepository.remove(actor, params.id, params.userId);
    return reply.status(204).send();
  });
}
