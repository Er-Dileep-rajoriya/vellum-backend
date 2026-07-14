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
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
