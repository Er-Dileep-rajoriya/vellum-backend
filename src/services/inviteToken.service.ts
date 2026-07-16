import { createHmac, randomBytes } from "node:crypto";

import { env } from "@/config/env.js";

/**
 * Invitation-link tokens.
 *
 * Unlike the 6-digit OTP (which is deliberately low-entropy and defended by an attempt cap), an
 * invitation token is a **capability**: whoever holds it can view the invitation, and — if their
 * signed-in email matches — accept it. So it must be unguessable on its own: 32 random bytes, 256
 * bits, URL-safe.
 *
 * As with the OTP, the raw token is NEVER stored. What the database holds is its HMAC-SHA256 keyed by
 * the server secret. Two consequences: a database dump does not yield a working invite link, and the
 * lookup is a single indexed point-read on the hash (see Invitation.tokenHash `@unique`) rather than a
 * scan. There is no timing concern in the lookup — a wrong token simply hashes to a value that matches
 * no row, and the hash space is far too large to probe.
 */

/** A URL-safe, 256-bit token to embed in the invitation link. */
export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

/** HMAC-SHA256(token, API_JWT_SECRET), hex. This — never the token — is what the database stores. */
export function hashInviteToken(token: string): string {
  return createHmac("sha256", env.API_JWT_SECRET).update(token).digest("hex");
}
