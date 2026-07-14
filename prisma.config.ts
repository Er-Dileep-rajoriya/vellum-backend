import "dotenv/config";
import { defineConfig, env } from "prisma/config";

/**
 * Prisma 7 moves datasource configuration out of schema.prisma so that the CLI (migrate,
 * studio, db push) and the runtime client can point at different connections — which is
 * exactly what integration tests need: the CLI migrates the test database while the dev
 * server keeps talking to the dev one.
 *
 * `prisma migrate` reads DATABASE_URL from here. The application runtime never uses this
 * file; it constructs PrismaClient with an explicit PrismaPg adapter (see src/database/client.ts).
 */
/**
 * The datasource URL, resolved lazily-ish.
 *
 * `env("DATABASE_URL")` throws the moment this config file is *loaded*, and the config is loaded by
 * every Prisma CLI command — including `prisma generate`, which never opens a connection. That made a
 * fresh `pnpm install` (which runs `prisma generate` via postinstall, so the generated client exists
 * before anything tries to typecheck against it) fail on a machine that has no database configured yet:
 * CI, a new clone, a Docker-less laptop on its first day.
 *
 * So: absent DATABASE_URL is not an error *here*. It is an error when something actually needs to
 * connect, and it fails there with the clearest possible message — the commands that connect
 * (`migrate`, `studio`, `seed`) cannot reach a host called `database-url-not-set` and say so.
 * Generation, which needs no connection, proceeds.
 */
const url = process.env["DATABASE_URL"]
  ? env("DATABASE_URL")
  : "postgresql://database-url-not-set:5432/unset";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url,
  },
});
