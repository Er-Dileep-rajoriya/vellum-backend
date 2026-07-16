import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";

import { env, isProduction } from "@/config/env.js";
import { MAX_REQUEST_BYTES } from "@/constants/limits.js";
import { registerErrorHandler } from "@/middlewares/error.middleware.js";
import { ipRateLimit } from "@/middlewares/rateLimit.middleware.js";
import { aiRoutes } from "@/routes/ai.routes.js";
import { authRoutes } from "@/routes/auth.routes.js";
import { documentRoutes } from "@/routes/document.routes.js";
import { invitationRoutes } from "@/routes/invitation.routes.js";
import { syncRoutes } from "@/routes/sync.routes.js";
import { versionRoutes } from "@/routes/version.routes.js";
import { logger } from "@/utils/logger.js";

/**
 * BigInt does not survive JSON.
 *
 * `serverSeq` is a Postgres bigint and it is the sync cursor of the entire system. JSON numbers are
 * IEEE-754 doubles, which lose integer precision above 2^53 — so a naive serialisation would, at
 * some distant future document size, silently round a cursor. A client that resumes from a rounded
 * cursor skips operations, and the resulting divergence would be blamed on the CRDT for months.
 *
 * Node's default is to throw on BigInt in JSON.stringify, which is the correct behaviour and the
 * reason the repositories already convert to strings at their boundary. This serialiser is the
 * belt-and-braces: if a bigint ever escapes a repository, it becomes a string rather than an
 * exception in production or, worse, a rounded number.
 */
function serializeWithBigInt(payload: unknown): string {
  return JSON.stringify(payload, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    /**
     * Widened to the interface Fastify declares rather than pino's concrete `Logger`.
     *
     * This assertion is LOAD-BEARING, despite looking redundant. Passing the narrow pino type
     * specialises `FastifyInstance`'s logger generic, and every route plugin — typed against the
     * default `FastifyBaseLogger` — then fails to match. The runtime object is identical; the cast
     * exists purely to stop the generic leaking into every plugin signature in the app.
     *
     * `eslint --fix` removed it once as an "unnecessary assertion" and broke the build. The rule is
     * disabled here rather than the cast being deleted again by the next person who runs autofix.
     */
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    loggerInstance: logger as FastifyBaseLogger,
    /**
     * THE byte cap. Fastify aborts the request while it is still being *streamed* — before the JSON
     * parser is invoked, before a buffer is allocated for the body. This is the difference between
     * rejecting a 900MB payload and being OOM-killed by one, and it is why validation alone is not
     * enough: `await request.json()` on an unbounded body has already lost. (DECISIONS.md D-013.)
     */
    bodyLimit: MAX_REQUEST_BYTES,
    // Trust the proxy's X-Forwarded-For (Fly/Vercel terminate TLS upstream) so rate limits and audit
    // logs see the real client IP rather than the load balancer's.
    trustProxy: isProduction,
    // A request that has not sent its body within 10s is either dead or slowloris-ing. Either way it
    // is holding a connection we would rather give to a real user.
    requestTimeout: 10_000,
    // Per-request logging stays ON. In production it is the access log — the thing you reach for at
    // 3am when someone asks "did that request arrive?" — and in development pino-pretty keeps it
    // readable. (Fastify 5 deprecates the `disableRequestLogging` flag in favour of a full
    // `logController` object; suppressing the logs is not worth implementing one.)
  });

  app.setSerializerCompiler(() => serializeWithBigInt);
  app.addHook("onSend", async (_request, reply, payload: unknown) => {
    if (typeof payload === "object" && payload !== null) {
      void reply.header("content-type", "application/json; charset=utf-8");
      return serializeWithBigInt(payload);
    }
    return payload;
  });

  await app.register(helmet, {
    // This is a JSON API: it renders nothing, so a CSP that permits nothing is exactly right. If a
    // browser is ever tricked into rendering a response from this origin, there is nothing for it
    // to execute.
    contentSecurityPolicy: { directives: { "default-src": ["'none'"], "frame-ancestors": ["'none'"] } },
    crossOriginResourcePolicy: { policy: "same-site" },
  });

  await app.register(cors, {
    // An explicit allowlist from the environment, validated at boot to never contain "*" — a
    // wildcard origin plus credentials is the classic CORS misconfiguration, and the environment
    // schema refuses to let this service start with one.
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-Client-Id"],
    maxAge: 86_400,
  });

  registerErrorHandler(app);

  /**
   * The front door: an IP-keyed limiter that runs before authentication, so an unauthenticated flood
   * is rejected before it costs us a HMAC verification or a database round trip. The real per-user
   * budget runs later, inside the route plugins, once there is an Actor to key it by.
   */
  app.addHook("onRequest", ipRateLimit);

  /**
   * Liveness. Deliberately does NOT touch the database: a health check that fails when Postgres is
   * briefly slow gets the whole fleet restarted by the orchestrator, turning a recoverable database
   * blip into a full outage. Readiness (which does check the database) is a different question and
   * belongs on a different endpoint.
   */
  app.get("/health", async () => ({ status: "ok", uptime: process.uptime() }));

  await app.register(documentRoutes, { prefix: "/api" });
  await app.register(invitationRoutes, { prefix: "/api" });
  await app.register(syncRoutes, { prefix: "/api" });
  await app.register(versionRoutes, { prefix: "/api" });
  await app.register(aiRoutes, { prefix: "/api" });
  await app.register(authRoutes, { prefix: "/api" });

  return app;
}
