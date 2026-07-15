import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

import { env } from "@/config/env.js";

/**
 * One-time codes for email verification and password reset.
 *
 * Two deliberate choices:
 *
 *  1. **The code is six digits, and that is fine — because of the attempt cap, not the code.** Six
 *     digits is ~20 bits: guessable in a million tries. The security does not come from the code's
 *     entropy; it comes from `attempts` being capped at a handful in the database and the code
 *     expiring in minutes. A short code the user can retype from their phone beats a long token they
 *     copy-paste wrong, *given* the cap. The cap is the control; the code is the UX.
 *
 *  2. **We store an HMAC, never the code.** A plain SHA-256 of a 6-digit code is reversible by
 *     hashing all million candidates — a rainbow table you rebuild in under a second. Keying the
 *     hash with the server secret (`API_JWT_SECRET`, the same 32+ byte value the app already
 *     guarantees at boot) means an attacker holding a database dump cannot derive a single live
 *     code without also holding the secret, which lives only in the process environment.
 */

const CODE_DIGITS = 6;

/**
 * A uniform 6-digit code, left-padded with zeros so "004217" is a valid code and not "4217".
 *
 * `randomInt` is rejection-sampled by Node, so there is no modulo bias — every value in
 * [0, 1_000_000) is equally likely, which a naive `randomBytes % 1_000_000` would not give.
 */
export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(CODE_DIGITS, "0");
}

/** HMAC-SHA256 of the code, keyed by the server secret. Hex. This is what goes in the database. */
export function hashOtp(code: string): string {
  return createHmac("sha256", env.API_JWT_SECRET).update(code).digest("hex");
}

/**
 * Constant-time comparison of a presented code against a stored hash.
 *
 * The hashes are equal-length hex, so `timingSafeEqual` never throws on a length mismatch — but the
 * guard stays, because a malformed stored hash (a bad row) must be a verification *failure*, not an
 * exception thrown from inside the auth path.
 */
export function verifyOtp(code: string, storedHash: string): boolean {
  const presented = Buffer.from(hashOtp(code), "hex");
  const expected = Buffer.from(storedHash, "hex");

  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
