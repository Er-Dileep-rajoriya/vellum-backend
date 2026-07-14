import { randomUUID } from "node:crypto";

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import { isProduction } from "@/config/env.js";
import { isAppError } from "@/utils/errors.js";
import { logger } from "@/utils/logger.js";

/**
 * The single exit point for every error in the service.
 *
 * Three jobs, in priority order:
 *
 *  1. **Leak nothing.** An unrecognised error becomes a bare 500 with a correlation id. The stack,
 *     the SQL, the constraint name, the row contents — all go to the log, none go over the wire. The
 *     most common information disclosure in production systems is not a clever exploit; it is a
 *     database error string rendered straight into a JSON response.
 *
 *  2. **Tell the client whether to retry.** The `retryable` flag drives the sync engine's queues: a
 *     retryable error goes back on the retry queue with exponential backoff, a non-retryable one goes
 *     to the dead-letter queue where a human can see it. Get this wrong and you either retry a
 *     malformed operation until the heat death of the universe, or you silently discard a user's
 *     writes because of a transient 503.
 *
 *  3. **Be machine-readable.** A stable `code` string, not a prose message the client string-matches
 *     on and that breaks the day someone fixes a typo.
 */

interface ErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId: string;
    details?: unknown;
  };
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = randomUUID();

    // Zod: a validation failure is the client's fault and is safe to describe precisely. Field paths
    // and messages are exactly what a developer integrating against the API needs, and they reveal
    // nothing that the API's own schema does not already document.
    if (error instanceof ZodError) {
      logger.info(
        { requestId, path: request.url, issues: error.issues.length },
        "request failed validation",
      );
      return reply.status(422).send({
        error: {
          code: "VALIDATION_FAILED",
          message: "request failed validation",
          retryable: false,
          requestId,
          details: {
            issues: error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
        },
      } satisfies ErrorBody);
    }

    if (isAppError(error)) {
      const appError = error;

      // 4xx are the client's problem and are logged at info: they are *normal traffic* for a sync
      // API (a 409 on a lock race, a 429 under load, a 410 for a stale cursor). Logging them as
      // errors trains everyone to ignore the error log, which is how a real incident gets missed.
      const level = appError.status >= 500 ? "error" : "info";
      logger[level](
        { requestId, code: appError.code, path: request.url, userId: request.actor?.userId },
        appError.message,
      );

      if (appError.retryAfterSeconds !== undefined) {
        void reply.header("Retry-After", String(appError.retryAfterSeconds));
      }

      return reply.status(appError.status).send({
        error: {
          code: appError.code,
          message: appError.message,
          retryable: appError.retryable,
          requestId,
          ...(appError.details !== undefined ? { details: appError.details } : {}),
        },
      } satisfies ErrorBody);
    }

    // Fastify's own errors. The body-limit rejection arrives here, and it is the one that matters:
    // it fires while the request is still being *streamed*, before any parser has allocated for it.
    // That is the difference between rejecting a 900MB body and being killed by it. (D-013.)
    if (error.statusCode === 413 || error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      logger.warn({ requestId, path: request.url }, "request body exceeded the hard limit");
      return reply.status(413).send({
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: "request body is too large",
          retryable: false,
          requestId,
        },
      } satisfies ErrorBody);
    }

    if (error.statusCode !== undefined && error.statusCode < 500) {
      return reply.status(error.statusCode).send({
        error: {
          code: "BAD_REQUEST",
          message: error.message,
          retryable: false,
          requestId,
        },
      } satisfies ErrorBody);
    }

    // Everything else is our fault and its details are nobody else's business.
    logger.error(
      { requestId, err: error, path: request.url, userId: request.actor?.userId },
      "unhandled error",
    );

    return reply.status(500).send({
      error: {
        code: "INTERNAL",
        message: isProduction ? "internal error" : error.message,
        retryable: true,
        requestId,
      },
    } satisfies ErrorBody);
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: "route not found",
        retryable: false,
        requestId: randomUUID(),
      },
    } satisfies ErrorBody);
  });
}
