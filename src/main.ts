import { attachWebSocketServer } from "@/collaboration/wsServer.js";
import { env } from "@/config/env.js";
import { disconnectDatabase } from "@/database/client.js";
import { idempotencyRepository } from "@/repositories/idempotency.repository.js";
import { rateLimitRepository } from "@/repositories/rateLimit.repository.js";
import { buildServer } from "@/server.js";
import { logger } from "@/utils/logger.js";

/**
 * Process entry point.
 *
 * The interesting part is the shutdown, not the startup. A sync server that is SIGTERM'd mid-commit
 * (which is every deploy, on every platform, several times a day) must finish the commits it has
 * already accepted. Killing the process with in-flight transactions means a client that received no
 * acknowledgement for operations that *did* land — it will retry them, which is safe (they are
 * idempotent), but it will also sit in a backoff loop for no reason.
 *
 * So: stop accepting new connections, drain the in-flight ones, close the database, exit. In that
 * order. The forced-exit timer exists because a hung drain is worse than a hard kill: the
 * orchestrator will SIGKILL us anyway, and it will do it at a moment of its choosing rather than ours.
 */

const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const app = await buildServer();

  // The WebSocket relay shares the HTTP server's port and its process. It does NOT share its write
  // path with anything of its own: it calls the same `syncService.push` the HTTP route calls, so the
  // socket cannot become a way around a check that HTTP enforces. (DECISIONS.md D-006.)
  attachWebSocketServer(app.server);

  /** Periodic garbage collection of expired idempotency keys and rate-limit windows. */
  const gcTimer = setInterval(
    () => {
      void (async () => {
        try {
          const [keys, windows] = await Promise.all([
            idempotencyRepository.collectGarbage(),
            rateLimitRepository.collectGarbage(2 * 60 * 60 * 1_000),
          ]);
          if (keys > 0 || windows > 0) {
            logger.debug({ keys, windows }, "garbage collected");
          }
        } catch (error) {
          // GC failing is not worth taking the process down for; it will run again in 10 minutes.
          logger.warn({ err: error }, "garbage collection failed");
        }
      })();
    },
    10 * 60 * 1_000,
  );
  // Do not hold the event loop open for a housekeeping timer during shutdown.
  gcTimer.unref();

  await app.listen({ port: env.PORT, host: env.HOST });
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "vellum backend listening");

  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    // A second SIGTERM during a drain is the orchestrator losing patience. Honour it immediately
    // rather than restarting the drain and taking twice as long.
    if (shuttingDown) {
      logger.warn({ signal }, "second shutdown signal — exiting immediately");
      process.exit(1);
    }
    shuttingDown = true;

    logger.info({ signal }, "shutting down");

    const forceExit = setTimeout(() => {
      logger.error("graceful shutdown timed out — forcing exit");
      process.exit(1);
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    void (async () => {
      try {
        clearInterval(gcTimer);
        // `close()` stops accepting new requests and waits for in-flight handlers to finish. The
        // commits already inside a transaction are what we are protecting here.
        await app.close();
        await disconnectDatabase();
        logger.info("shutdown complete");
        process.exit(0);
      } catch (error) {
        logger.error({ err: error }, "error during shutdown");
        process.exit(1);
      }
    })();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  /**
   * An unhandled rejection means a promise failed and nobody was listening — the process is now in a
   * state nobody reasoned about. Crashing is the honest response; continuing is how a service ends up
   * silently serving wrong answers. The orchestrator restarts us in a known-good state, which is
   * strictly better than an unknown one.
   */
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandled rejection — crashing");
    shutdown("unhandledRejection");
  });

  process.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, "uncaught exception — crashing");
    shutdown("uncaughtException");
  });
}

void main();
