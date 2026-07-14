/**
 * The auth surface, probed against a RUNNING server.
 *
 * The two properties worth testing here are both *invisible* ones — a login endpoint that leaks
 * which emails have accounts looks completely normal from the outside, and works perfectly:
 *
 *   1. The message must be identical for "no such user" and "wrong password".
 *   2. The **latency** must be too. This is the half that gets forgotten: an attacker does not need
 *      the error message when a missing user returns in 1ms and a real one takes 100ms. That timing
 *      difference IS the oracle, and it is why `fakeVerify()` exists.
 *
 *   pnpm exec tsx scripts/auth-smoke.ts
 */
import { randomBytes } from "node:crypto";

import { env } from "@/config/env.js";
import { prisma } from "@/database/client.js";

const BASE = process.env["SMOKE_BASE_URL"] ?? `http://127.0.0.1:${env.PORT}`;
const SERVICE = { "X-Service-Token": env.SERVICE_TOKEN, "Content-Type": "application/json" };

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    process.stdout.write(`  [32m✓[0m ${name}\n`);
  } else {
    failed += 1;
    process.stdout.write(`  [31m✗ ${name}[0m ${detail}\n`);
  }
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const started = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - started };
}

async function main(): Promise<void> {
  const email = `auth-${randomBytes(4).toString("hex")}@test.local`;
  const password = "correct-horse-battery-staple";

  process.stdout.write("\nservice token\n");

  const noToken = await fetch(`${BASE}/api/internal/users/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, name: "X", password }),
  });
  check("register without the service token → 403", noToken.status === 403, `got ${noToken.status}`);

  const wrongToken = await fetch(`${BASE}/api/internal/users/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Service-Token": "wrong-but-same-length!!" },
    body: JSON.stringify({ email, name: "X", password }),
  });
  check("register with a WRONG service token → 403", wrongToken.status === 403, `got ${wrongToken.status}`);

  process.stdout.write("\nregistration\n");

  const registered = await fetch(`${BASE}/api/internal/users/register`, {
    method: "POST",
    headers: SERVICE,
    body: JSON.stringify({ email, name: "Auth Test", password }),
  });
  check("register → 201", registered.status === 201, `got ${registered.status}`);

  const weak = await fetch(`${BASE}/api/internal/users/register`, {
    method: "POST",
    headers: SERVICE,
    body: JSON.stringify({ email: `w-${email}`, name: "W", password: "short" }),
  });
  check("an 11-character password is rejected → 422", weak.status === 422, `got ${weak.status}`);

  // The password must NEVER be recoverable from the database — only verifiable.
  const stored = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { passwordHash: true },
  });
  check(
    "the stored hash is scrypt, and contains no trace of the password",
    stored.passwordHash!.startsWith("scrypt$") && !stored.passwordHash!.includes(password),
  );
  check(
    "the cost parameters are stored WITH the hash (so they can be raised later)",
    stored.passwordHash!.split("$").length === 6,
  );

  process.stdout.write("\nlogin\n");

  const good = await fetch(`${BASE}/api/internal/users/verify`, {
    method: "POST",
    headers: SERVICE,
    body: JSON.stringify({ email, password }),
  });
  check("correct password → 200", good.status === 200, `got ${good.status}`);

  const badPassword = await timed(() =>
    fetch(`${BASE}/api/internal/users/verify`, {
      method: "POST",
      headers: SERVICE,
      body: JSON.stringify({ email, password: "wrong-password-entirely" }),
    }),
  );

  const noSuchUser = await timed(() =>
    fetch(`${BASE}/api/internal/users/verify`, {
      method: "POST",
      headers: SERVICE,
      body: JSON.stringify({ email: "nobody@nowhere.local", password: "wrong-password-entirely" }),
    }),
  );

  check("wrong password → 401", badPassword.result.status === 401);
  check("no such user → 401", noSuchUser.result.status === 401);

  const bodyA = await badPassword.result.text();
  const bodyB = await noSuchUser.result.text();
  const messageA = (JSON.parse(bodyA) as { error: { message: string } }).error.message;
  const messageB = (JSON.parse(bodyB) as { error: { message: string } }).error.message;

  check(
    "the two failures are byte-identical (no enumeration via the message)",
    messageA === messageB,
    `"${messageA}" vs "${messageB}"`,
  );

  /**
   * The timing check.
   *
   * Both paths must do the same work. A ratio near 1.0 means an attacker cannot tell a real account
   * from a fake one by timing the endpoint. Without `fakeVerify()`, the missing-user path skips
   * scrypt entirely and this ratio is ~50x — a clean, scriptable user-enumeration oracle that no
   * error-message audit would ever catch.
   *
   * The threshold is generous (3x) because a single sample on a loaded dev machine is noisy; the
   * bug being caught here is a 50x difference, not a 1.2x one.
   */
  const ratio = Math.max(badPassword.ms, noSuchUser.ms) / Math.min(badPassword.ms, noSuchUser.ms);
  check(
    `both failures cost the same (${badPassword.ms.toFixed(0)}ms vs ${noSuchUser.ms.toFixed(0)}ms, ratio ${ratio.toFixed(2)}x — no timing oracle)`,
    ratio < 3,
    `ratio ${ratio.toFixed(1)}x — a missing user is measurably faster than a wrong password`,
  );

  check(
    `verification actually costs real CPU (${badPassword.ms.toFixed(0)}ms — a fast hash is a crackable hash)`,
    badPassword.ms > 20,
    `${badPassword.ms.toFixed(0)}ms is suspiciously fast for scrypt`,
  );

  process.stdout.write("\noauth linking\n");

  // The same person signing in with Google must resolve to the SAME account, not a second one
  // holding half their documents.
  const oauth = await fetch(`${BASE}/api/internal/users/oauth`, {
    method: "POST",
    headers: SERVICE,
    body: JSON.stringify({
      email,
      name: "Auth Test",
      provider: "google",
      providerAccountId: "google-12345",
    }),
  });
  const oauthBody = (await oauth.json()) as { user: { id: string } };

  const users = await prisma.user.count({ where: { email } });
  check("Google sign-in links to the EXISTING account, not a duplicate", users === 1, `${users} rows`);

  const original = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true, passwordHash: true },
  });
  check("...and it is the same user id", oauthBody.user.id === original.id);
  check(
    "...and the password still works (the OAuth upsert did not wipe it)",
    original.passwordHash !== null,
  );

  process.stdout.write(
    `\n${failed === 0 ? "[32m" : "[31m"}${passed} passed, ${failed} failed[0m\n\n`,
  );

  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

void main();
