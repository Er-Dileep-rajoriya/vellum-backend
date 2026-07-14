import { PrismaPg } from "@prisma/adapter-pg";

import { env, isProduction } from "@/config/env.js";
import { PrismaClient } from "@/generated/prisma/client.js";

/**
 * The single Prisma client for the process.
 *
 * Prisma 7 connects through a driver adapter rather than a bundled Rust engine, which means the
 * connection pool is `pg`'s and is configured here, explicitly, instead of being an opaque
 * default. That matters: the pool size is the real concurrency limit of this service, and a
 * default that is wrong is a default that shows up as latency under load with no obvious cause.
 *
 * Pool sizing: Postgres handles connections with a process per connection, so more is not better.
 * 10 per instance is deliberately modest — the workload is short transactions (an op batch commit
 * is a few milliseconds), so throughput comes from turning connections over quickly, not from
 * holding many open. Scale out by adding instances, and put PgBouncer in front before raising this.
 */
const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
  max: 10,
  // A connection that cannot be established in 5s is a connection that is not coming; failing fast
  // turns a slow, invisible pile-up into a clear error the caller can retry with backoff.
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

/**
 * Hot reload (tsx watch) re-evaluates modules and would otherwise construct a new pool on every
 * save, exhausting Postgres' connection slots within a few minutes of development. The global
 * cache is a development-only concern and is deliberately not applied in production, where the
 * module is evaluated exactly once.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: isProduction ? ["warn", "error"] : ["warn", "error"],
  });

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}

/**
 * Postgres advisory locks are keyed by a 64-bit integer, not a string. Document ids are cuid2
 * strings, so they must be hashed into that space.
 *
 * `hashtextextended` is Postgres' own hash function — computed in the database, not in Node, which
 * guarantees every instance of this service (and any future service, in any language) derives the
 * identical lock key from the same document id. A hash computed in application code would drift
 * the moment a second implementation appeared, and two services holding "different" locks for the
 * same document is a silent, intermittent, extremely expensive bug.
 *
 * Collisions are harmless: two documents that hash to the same key serialise against each other
 * unnecessarily. That costs a little throughput on an astronomically unlikely pair, and costs
 * nothing in correctness.
 */
export async function withDocumentLock<T>(
  tx: Pick<PrismaClient, "$executeRaw">,
  documentId: string,
  fn: () => Promise<T>,
): Promise<T> {
  // pg_advisory_xact_lock releases automatically when the transaction ends — including when it
  // aborts. There is no path, not even an unhandled exception, that leaks this lock. An explicit
  // unlock in a `finally` would be strictly worse: it can be skipped by a process crash.
  //
  // $executeRaw, not $queryRaw: the function returns `void`, and Prisma's row deserialiser has no
  // mapping for a void column — it throws rather than returning an empty row. We want the side
  // effect, not the result set, and $executeRaw is the call that says so.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${documentId}, 0))`;
  return fn();
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
