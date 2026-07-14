import type { FastifyReply, FastifyRequest } from "fastify";

import { extractBearerToken, verifyAccessToken, verifyServiceToken } from "@/services/token.service.js";
import type { Actor } from "@/types/actor.js";
import { forbidden, unauthenticated } from "@/utils/errors.js";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Populated by `requireAuth` only. Typed as optional so that a handler which forgot the
     * preHandler cannot reach `request.actor.userId` without TypeScript objecting — the type system
     * enforcing that authentication ran, rather than a code reviewer.
     */
    actor?: Actor;
  }
}

/**
 * Authenticate the caller and attach the Actor.
 *
 * Every claim on the request — who you are, what you may do — derives from the verified token and
 * nothing else. There is no path where a header, a query parameter, or a body field can name a user.
 */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = extractBearerToken(request.headers.authorization);
  if (token === null) throw unauthenticated("missing bearer token");

  request.actor = await verifyAccessToken(token);
}

/**
 * Service-to-service authentication, for the endpoints the frontend's Auth.js callbacks use to
 * create and look up users (the frontend has no database access of its own).
 *
 * This is a powerful credential — it can mint users — so it is scoped to exactly those routes and
 * nothing else, and it never grants an Actor. A caller holding the service token is not "logged in
 * as" anybody, and cannot use these routes to reach a document.
 */
export async function requireServiceToken(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const header = request.headers["x-service-token"];
  const token = Array.isArray(header) ? header[0] : header;

  if (!verifyServiceToken(token)) {
    throw forbidden("invalid service token");
  }
}

/**
 * Narrows `request.actor` for handlers running behind `requireAuth`.
 *
 * The throw is unreachable if the route is wired correctly — which is exactly why it is here. If
 * someone adds a route and forgets the preHandler, this fails closed with a 401 rather than
 * dereferencing undefined and returning a 500 that leaks a stack trace.
 */
export function actorOf(request: FastifyRequest): Actor {
  if (request.actor === undefined) {
    throw unauthenticated("route is not authenticated");
  }
  return request.actor;
}
