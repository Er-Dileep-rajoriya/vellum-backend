import { pino, type Logger } from "pino";

import { env, isProduction } from "@/config/env.js";

/**
 * Structured logging.
 *
 * The redaction list is not boilerplate. Anything on it is a value that, once written to a log
 * aggregator, is effectively public inside the company forever — and access tokens and password
 * hashes have a way of arriving in logs by accident, via a generic `{ ...request.body }` spread
 * that someone added while debugging and never removed. Redacting at the logger means that
 * mistake is neutralised at the last line of defence rather than relying on nobody ever making it.
 *
 * Document content is never logged at all, at any level. It is the user's private writing, and it
 * has no business in an ops tool.
 */
export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-service-token']",
      "req.headers['idempotency-key']",
      "*.password",
      "*.passwordHash",
      "*.accessToken",
      "*.refreshToken",
      "*.idToken",
      "*.apiKey",
      "payload",
      "content",
      "operations",
    ],
    censor: "[redacted]",
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
        },
      }),
});

export type { Logger };
