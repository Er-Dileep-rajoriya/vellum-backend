import { timingSafeEqual } from "node:crypto";

import { jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";

import { env } from "@/config/env.js";
import type { Actor } from "@/types/actor.js";
import { unauthenticated } from "@/utils/errors.js";

/**
 * Access-token verification.
 *
 * Auth.js (in the frontend) owns the user's session and mints a short-lived HS256 token for this
 * API. This module turns that token into an `Actor` — and it is the ONLY place in the codebase that
 * is allowed to construct one. Every authorization decision downstream is built on the claims
 * verified here, so this file is the trust boundary of the entire service.
 */

const secret = new TextEncoder().encode(env.API_JWT_SECRET);

/**
 * The claims we require. `.strict()` is not used (a JWT legitimately carries iat/exp/etc), but every
 * claim we *act on* is validated: an `email` that is not an email, or a `sub` that is a 4KB string,
 * is a token we refuse rather than a token we work around.
 */
const ClaimsSchema = z.object({
  sub: z.string().min(1).max(64),
  email: z.email(),
});

export async function verifyAccessToken(token: string): Promise<Actor> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, secret, {
      // Pinning the algorithm is not optional. Without it, `jose` would accept whatever the token's
      // own header claims — and a token that says `"alg": "none"` is a token an attacker writes
      // themselves. This is the single most exploited JWT mistake in existence, and it is prevented
      // by one line.
      algorithms: ["HS256"],
      issuer: env.API_JWT_ISSUER,
      audience: env.API_JWT_AUDIENCE,
      // Expiry is enforced by jose. 15-minute tokens bound the blast radius of a leaked one; the
      // session cookie in the frontend is what silently re-mints them.
      clockTolerance: 5,
    }));
  } catch {
    // Deliberately opaque, and the error is deliberately NOT captured or logged. "signature invalid"
    // vs "expired" vs "wrong issuer" is a free oracle for anyone probing the token format, and the
    // client only ever needs to know one thing: re-authenticate.
    throw unauthenticated("invalid or expired access token");
  }

  const claims = ClaimsSchema.safeParse(payload);
  if (!claims.success) {
    throw unauthenticated("access token is missing required claims");
  }

  return { userId: claims.data.sub, email: claims.data.email.toLowerCase() };
}

/**
 * The service token, used by the frontend's Auth.js callbacks to create and look up users (the
 * frontend has no database of its own).
 *
 * Compared in constant time. A `===` on a secret leaks its prefix through response timing — the
 * comparison returns early on the first differing byte, so an attacker can recover the token one
 * character at a time. The effect is small over a network but it is real, it is measurable, and the
 * fix costs nothing.
 */
export function verifyServiceToken(token: string | undefined): boolean {
  if (token === undefined) return false;

  const provided = Buffer.from(token);
  const expected = Buffer.from(env.SERVICE_TOKEN);

  // timingSafeEqual throws on a length mismatch, which would itself be a timing signal. Checking
  // the length first is safe: the length of the secret is not itself a secret.
  if (provided.length !== expected.length) return false;

  return timingSafeEqual(provided, expected);
}

/** Extracts a bearer token. Case-insensitive scheme, per RFC 6750. */
export function extractBearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
