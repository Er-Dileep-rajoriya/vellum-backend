import { execSync } from "node:child_process";

import { prisma } from "@/database/client.js";
import type { Role } from "@/generated/prisma/enums.js";
import type { Actor } from "@/types/actor.js";

let migrated = false;

/**
 * Bring the test database up to the current schema, once per process.
 *
 * `migrate deploy` (not `db push`) so the tests exercise the *same* migrations that will run in
 * production — including the immutability triggers, which `db push` would silently skip because
 * they live in hand-written SQL rather than in the Prisma schema. A test suite that runs against a
 * schema production will never have is a test suite that proves nothing.
 */
export function migrateTestDatabase(): void {
  if (migrated) return;

  execSync("pnpm exec prisma migrate deploy", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: process.env["TEST_DATABASE_URL"] },
  });
  migrated = true;
}

/**
 * Reset between tests.
 *
 * TRUNCATE ... CASCADE, not DELETE: it resets in one statement regardless of foreign-key order, and
 * it does not fire the row-level triggers that (correctly) forbid DELETE on the append-only tables.
 * A cleanup routine that has to be granted an exemption from the system's own safety rules is a
 * cleanup routine that will eventually be used to bypass them in production.
 */
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      audit_logs, ai_history, failed_operations, sync_sessions, versions,
      operations, collaborators, documents, accounts, users,
      idempotency_keys, rate_limits
    RESTART IDENTITY CASCADE
  `);
}

let userCounter = 0;

export async function createUser(name = "Test User"): Promise<Actor> {
  userCounter += 1;
  const email = `user${userCounter}@test.local`;
  const user = await prisma.user.create({
    data: { email, name },
    select: { id: true, email: true },
  });
  return { userId: user.id, email: user.email };
}

/** A document owned by `owner`, with the owner's OWNER collaborator row (as the repository does). */
export async function createDocument(owner: Actor, title = "Test Document"): Promise<string> {
  const document = await prisma.document.create({
    data: {
      title,
      ownerId: owner.userId,
      collaborators: { create: { userId: owner.userId, role: "OWNER" } },
    },
    select: { id: true },
  });
  return document.id;
}

export async function addCollaborator(
  documentId: string,
  actor: Actor,
  role: Role,
): Promise<void> {
  await prisma.collaborator.create({
    data: { documentId, userId: actor.userId, role },
  });
}
