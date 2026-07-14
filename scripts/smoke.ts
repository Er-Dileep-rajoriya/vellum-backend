/**
 * End-to-end smoke test against a RUNNING server.
 *
 * The integration suite exercises the repositories directly. This exercises the actual HTTP surface:
 * real tokens, real headers, real middleware ordering, real serialisation. Bugs live in the seams —
 * a hook registered in the wrong order, a bigint that JSON.stringify turns into an exception, a
 * validator that runs after the thing it was supposed to guard. None of those are visible from a
 * repository test.
 *
 *   pnpm exec tsx scripts/smoke.ts
 */
import { randomBytes } from "node:crypto";

import { SignJWT } from "jose";
import { ulid } from "ulid";

import { env } from "@/config/env.js";
import { prisma } from "@/database/client.js";

/**
 * The target. Defaults to the local server; override to smoke a deployed one.
 *
 *   SMOKE_BASE_URL=https://api-vellum.paperflow.in pnpm smoke
 *
 * It was hardcoded to localhost, which quietly meant the 21 checks in this file could only ever be run
 * against a machine you were already sitting on — so the environment they never got run against was the
 * only one that mattered. A deployment is exactly when you want to ask "does a forged JWT still get a
 * 401, does a 2MB body still get a 413, does a stranger still get a 404 instead of a 403".
 *
 * Note this script also talks to the database directly (it seeds users and reads back what the API
 * wrote), so it must run somewhere that can reach both — the server itself, or a tunnel.
 */
const BASE = process.env["SMOKE_BASE_URL"] ?? `http://127.0.0.1:${env.PORT}`;
const secret = new TextEncoder().encode(env.API_JWT_SECRET);

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    process.stdout.write(`  [32m✓[0m ${name}\n`);
  } else {
    failed += 1;
    process.stdout.write(`  [31m✗ ${name}[0m ${detail}\n`);
  }
}

async function mintToken(userId: string, email: string): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(env.API_JWT_ISSUER)
    .setAudience(env.API_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(secret);
}

async function main(): Promise<void> {
  // A real user, created the way the service-token endpoints will create them.
  const email = `smoke-${randomBytes(4).toString("hex")}@test.local`;
  const user = await prisma.user.create({ data: { email, name: "Smoke" } });
  const token = await mintToken(user.id, email);
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  process.stdout.write("\nauth\n");

  const noToken = await fetch(`${BASE}/api/documents`);
  check("no token → 401", noToken.status === 401, `got ${noToken.status}`);

  const badToken = await fetch(`${BASE}/api/documents`, {
    headers: { Authorization: "Bearer not-a-jwt" },
  });
  check("malformed token → 401", badToken.status === 401, `got ${badToken.status}`);

  // The alg:none attack. A token whose header claims no signature is a token the attacker wrote.
  const algNone =
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url") +
    "." +
    Buffer.from(JSON.stringify({ sub: user.id, email, iss: env.API_JWT_ISSUER, aud: env.API_JWT_AUDIENCE })).toString("base64url") +
    ".";
  const algNoneResponse = await fetch(`${BASE}/api/documents`, {
    headers: { Authorization: `Bearer ${algNone}` },
  });
  check("alg:none forgery → 401", algNoneResponse.status === 401, `got ${algNoneResponse.status}`);

  process.stdout.write("\ndocuments\n");

  const created = await fetch(`${BASE}/api/documents`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ title: "Smoke Document" }),
  });
  const { document } = (await created.json()) as { document: { id: string; serverSeq: string } };
  check("create → 201", created.status === 201, `got ${created.status}`);
  check(
    "serverSeq is a STRING, not a rounded number",
    typeof document.serverSeq === "string",
    `got ${typeof document.serverSeq}`,
  );

  process.stdout.write("\nsync push\n");

  const operations = [
    {
      operationId: ulid(),
      clientId: "smoke-client",
      logicalClock: 1,
      timestamp: new Date().toISOString(),
      documentVersion: "0",
      operationType: "BLOCK_INSERT",
      payload: { blockId: "b1", blockType: "paragraph", fracIndex: "a0", attrs: {} },
    },
    {
      operationId: ulid(),
      clientId: "smoke-client",
      logicalClock: 2,
      timestamp: new Date().toISOString(),
      documentVersion: "0",
      operationType: "TEXT_INSERT",
      payload: { blockId: "b1", charId: "smoke-client:1", originLeft: null, value: "Hello" },
    },
  ];
  const pushBody = JSON.stringify({ documentId: document.id, clientId: "smoke-client", operations });
  const idempotencyKey = ulid();

  const missingKey = await fetch(`${BASE}/api/sync/push`, {
    method: "POST",
    headers: auth,
    body: pushBody,
  });
  check("push without Idempotency-Key → 400", missingKey.status === 400, `got ${missingKey.status}`);

  const push = await fetch(`${BASE}/api/sync/push`, {
    method: "POST",
    headers: { ...auth, "Idempotency-Key": idempotencyKey },
    body: pushBody,
  });
  const pushResult = (await push.json()) as {
    acknowledged: Array<{ serverSeq: string; userId: string }>;
    duplicateCount: number;
    documentSeq: string;
  };
  check("push → 200", push.status === 200, `got ${push.status}`);
  check(
    "gapless sequence assigned",
    pushResult.acknowledged.map((op) => op.serverSeq).join(",") === "1,2",
    JSON.stringify(pushResult.acknowledged.map((op) => op.serverSeq)),
  );
  check(
    "userId taken from the token, not the wire",
    pushResult.acknowledged.every((op) => op.userId === user.id),
  );

  const replay = await fetch(`${BASE}/api/sync/push`, {
    method: "POST",
    headers: { ...auth, "Idempotency-Key": idempotencyKey },
    body: pushBody,
  });
  const replayResult = (await replay.json()) as { acknowledged: Array<{ serverSeq: string }> };
  check(
    "replayed batch returns the ORIGINAL acks",
    JSON.stringify(replayResult.acknowledged.map((o) => o.serverSeq)) ===
      JSON.stringify(pushResult.acknowledged.map((o) => o.serverSeq)),
  );
  const opCount = await prisma.operation.count({ where: { documentId: document.id } });
  check("replay committed NOTHING new", opCount === 2, `${opCount} operations in the log`);

  // Same key, different body. Not a retry — a bug or an attack. Must be refused, never served
  // from cache.
  const tampered = await fetch(`${BASE}/api/sync/push`, {
    method: "POST",
    headers: { ...auth, "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({
      documentId: document.id,
      clientId: "smoke-client",
      operations: [{ ...operations[0], operationId: ulid() }],
    }),
  });
  check(
    "same key + different body → 422 (no cache poisoning)",
    tampered.status === 422,
    `got ${tampered.status}`,
  );

  process.stdout.write("\nsync pull\n");

  const pull = await fetch(`${BASE}/api/sync/pull?documentId=${document.id}&since=1`, {
    headers: auth,
  });
  const pullResult = (await pull.json()) as { operations: Array<{ serverSeq: string }> };
  check(
    "exclusive cursor: since=1 returns only seq 2",
    pullResult.operations.length === 1 && pullResult.operations[0]?.serverSeq === "2",
    JSON.stringify(pullResult.operations.map((o) => o.serverSeq)),
  );

  process.stdout.write("\nsecurity\n");

  // The OOM attack. This body is ~2MB of JSON; the cap is 1MB. It must be rejected while still
  // being streamed — before any parser allocates for it.
  const huge = JSON.stringify({
    documentId: document.id,
    clientId: "smoke-client",
    operations: [{ ...operations[0], payload: { ...operations[0]!.payload, attrs: { x: "A".repeat(2_000_000) } } }],
  });
  const oversize = await fetch(`${BASE}/api/sync/push`, {
    method: "POST",
    headers: { ...auth, "Idempotency-Key": ulid() },
    body: huge,
  });
  check(
    `2MB body → 413 (rejected pre-parse; sent ${(huge.length / 1_048_576).toFixed(1)}MB)`,
    oversize.status === 413,
    `got ${oversize.status}`,
  );

  const malformed = await fetch(`${BASE}/api/sync/push`, {
    method: "POST",
    headers: { ...auth, "Idempotency-Key": ulid() },
    body: "{not json",
  });
  check("malformed JSON → 400, not 500", malformed.status === 400, `got ${malformed.status}`);

  // An unknown key on an operation payload. `.strict()` means this is a rejection, not a shrug:
  // silently ignoring unknown fields is how a protocol change becomes a silent no-op in production.
  const unknownField = await fetch(`${BASE}/api/sync/push`, {
    method: "POST",
    headers: { ...auth, "Idempotency-Key": ulid() },
    body: JSON.stringify({
      documentId: document.id,
      clientId: "smoke-client",
      operations: [{ ...operations[0], operationId: ulid(), evil: "payload" }],
    }),
  });
  check(
    "unknown field on an operation → 422 (strict schema)",
    unknownField.status === 422,
    `got ${unknownField.status}`,
  );

  // Tenant isolation: a stranger must get 404 (NOT 403) — a 403 would confirm the document exists.
  const stranger = await prisma.user.create({
    data: { email: `stranger-${randomBytes(4).toString("hex")}@test.local` },
  });
  const strangerToken = await mintToken(stranger.id, stranger.email);
  const strangerRead = await fetch(`${BASE}/api/documents/${document.id}`, {
    headers: { Authorization: `Bearer ${strangerToken}` },
  });
  check(
    "stranger reading a private document → 404, never 403 (no existence oracle)",
    strangerRead.status === 404,
    `got ${strangerRead.status}`,
  );

  const strangerPush = await fetch(`${BASE}/api/sync/push`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${strangerToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": ulid(),
    },
    body: pushBody,
  });
  check(
    "stranger pushing to a private document → 404",
    strangerPush.status === 404,
    `got ${strangerPush.status}`,
  );

  // A VIEWER cannot sync. This is the requirement that "viewers cannot edit" actually rests on:
  // for an offline-first client, an edit is a deferred push.
  const viewer = await prisma.user.create({
    data: { email: `viewer-${randomBytes(4).toString("hex")}@test.local` },
  });
  await prisma.collaborator.create({
    data: { documentId: document.id, userId: viewer.id, role: "VIEWER" },
  });
  const viewerToken = await mintToken(viewer.id, viewer.email);

  const viewerRead = await fetch(`${BASE}/api/documents/${document.id}`, {
    headers: { Authorization: `Bearer ${viewerToken}` },
  });
  check("viewer CAN read → 200", viewerRead.status === 200, `got ${viewerRead.status}`);

  const viewerPush = await fetch(`${BASE}/api/sync/push`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${viewerToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": ulid(),
    },
    body: JSON.stringify({
      documentId: document.id,
      clientId: "viewer-client",
      operations: [{ ...operations[0], operationId: ulid(), clientId: "viewer-client" }],
    }),
  });
  check("viewer CANNOT sync → 403", viewerPush.status === 403, `got ${viewerPush.status}`);

  const viewerDelete = await fetch(`${BASE}/api/documents/${document.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${viewerToken}` },
  });
  check("viewer CANNOT delete → 403", viewerDelete.status === 403, `got ${viewerDelete.status}`);

  process.stdout.write(
    `\n${failed === 0 ? "[32m" : "[31m"}${passed} passed, ${failed} failed[0m\n\n`,
  );

  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

void main();
