import type { FastifyReply, FastifyRequest } from "fastify";

import { env } from "@/config/env.js";
import { RATE_LIMIT_WINDOW_MS } from "@/constants/limits.js";
import { rateLimitRepository } from "@/repositories/rateLimit.repository.js";
import { rateLimited } from "@/utils/errors.js";

/**
 * Two limiters, at two different lifecycle stages, protecting two different things. The distinction
 * is not academic — collapsing them into one hook is a bug I wrote first and caught here:
 *
 *   `onRequest` runs BEFORE `preHandler`, and authentication happens in `preHandler`. A limiter in
 *   `onRequest` therefore has no Actor, and keying it "by user, falling back to IP" silently means
 *   "by IP, always" — so every authenticated user behind one corporate NAT shares a bucket, and the
 *   per-user limit that appears to exist does not.
 *
 * So:
 *
 *   1. `ipRateLimit`  (onRequest)  — the front door. Keyed by IP, generous, and its only job is to
 *      stop an unauthenticated flood before it reaches token verification (which costs a HMAC) or
 *      the database. Weak by nature: an attacker with a botnet has many IPs. It costs one upsert and
 *      it stops the trivial case, which is most cases.
 *
 *   2. `actorRateLimit` (preHandler, after requireAuth) — the real budget. Keyed by user, so it
 *      cannot be evaded by rotating IPs, and it is the one whose numbers actually mean something.
 */

export async function ipRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.method === "OPTIONS") return;
  if (request.url === "/health") return;

  const verdict = await rateLimitRepository.consume(
    `ip:${request.ip}`,
    // Deliberately looser than the per-user limit: a shared office NAT is one IP and fifty humans,
    // and throttling them all to one person's budget would be a self-inflicted outage.
    env.RATE_LIMIT_REQUESTS_PER_MINUTE * 5,
    RATE_LIMIT_WINDOW_MS,
  );

  if (!verdict.allowed) throw rateLimited(verdict.retryAfterSeconds);
  void reply.header("X-RateLimit-Scope", "ip");
}

/** Must be registered AFTER `requireAuth`. Hooks run in registration order within a plugin. */
export async function actorRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const actor = request.actor;
  /* c8 ignore next -- unreachable behind requireAuth; fails closed rather than silently unlimited */
  if (actor === undefined) return;

  const verdict = await rateLimitRepository.consume(
    `req:${actor.userId}`,
    env.RATE_LIMIT_REQUESTS_PER_MINUTE,
    RATE_LIMIT_WINDOW_MS,
  );

  void reply.header("X-RateLimit-Remaining", String(verdict.remaining));
  void reply.header("X-RateLimit-Scope", "user");

  if (!verdict.allowed) throw rateLimited(verdict.retryAfterSeconds);
}
