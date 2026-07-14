import { config } from "dotenv";

/**
 * Tests run against a real Postgres — a `vellum_test` database on the local server (TEST_DATABASE_URL).
 *
 * Not a mock, and not sqlite. The things this backend must get right — advisory locks, gapless
 * sequence assignment under concurrency, unique-constraint idempotency, cascade behaviour, and the
 * triggers that make history immutable — are all *Postgres* behaviours. A mocked Prisma client
 * would happily let every one of those bugs through while showing green, which is worse than no
 * test at all: it is a false statement about the system's safety.
 */
config({ path: ".env", quiet: true });

const testDatabaseUrl = process.env["TEST_DATABASE_URL"];
if (testDatabaseUrl === undefined || testDatabaseUrl === "") {
  throw new Error(
    "TEST_DATABASE_URL is not set. Run `pnpm db:up` and copy .env.example to .env.",
  );
}

// Point every module that reads DATABASE_URL (config/env.ts, prisma) at the *test* database before
// any of them are imported. Getting this wrong truncates the developer's dev database on every run,
// which is a mistake you only make once and never forget.
process.env["DATABASE_URL"] = testDatabaseUrl;
process.env["NODE_ENV"] = "test";
