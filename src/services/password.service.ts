import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing: scrypt, from Node's own crypto module.
 *
 * **Why scrypt and not bcrypt/argon2:** argon2id is the better algorithm, and both it and bcrypt
 * require a native dependency that must compile on every platform in the deploy chain. scrypt is
 * memory-hard, is in the standard library, and is what OWASP lists as an acceptable choice. A
 * password hash that ships and works everywhere beats a marginally better one that breaks the build
 * on Alpine.
 *
 * **Why not SHA-256 + salt:** because it is *fast*, and fast is the entire problem. A GPU does
 * billions of SHA-256 hashes per second. The parameters below are chosen to make each guess cost
 * ~64MB of memory and ~100ms of CPU — which is unnoticeable when a human logs in once, and
 * economically fatal to someone trying to brute-force a stolen database.
 */

const PARAMS = {
  /**
   * N=2^15 (32768): the CPU/memory cost factor. Memory used is roughly `128 * N * r` = ~64MB.
   * Memory-hardness is the point: it is what makes a GPU or ASIC no better at this than a CPU.
   */
  N: 32_768,
  r: 8,
  p: 1,
  // Node's default maxmem (32MB) is BELOW what N=2^15 needs, so scrypt would throw at the exact
  // moment a user tries to sign up. Raising it here is not a security relaxation — it is the
  // allocation the chosen cost factor actually requires.
  maxmem: 128 * 32_768 * 8 * 2,
} as const;

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * Format: `scrypt$N$r$p$salt$hash`, both hex.
 *
 * The parameters are stored WITH the hash, not read from a constant. That is what makes the cost
 * factor upgradable: when 2^15 is no longer enough, new passwords are hashed at 2^16 and old ones
 * still verify against the parameters they were created with. A hash format without embedded
 * parameters is a hash format you can never strengthen without logging everyone out.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, PARAMS);

  return [
    "scrypt",
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("hex"),
    derived.toString("hex"),
  ].join("$");
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupt row in the database is an
 * authentication failure, not a 500 that tells an attacker they found something interesting.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, rawN, rawR, rawP, rawSalt, rawHash] = parts;

  /**
   * Everything here is parsed from a database string, so nothing may be asserted.
   *
   * A non-null assertion is a promise to the compiler that a value exists. That promise is fine for
   * a literal you just constructed — and completely unjustified for a column that a bad migration, a
   * partial write, or a future bug could leave malformed. A corrupt hash row must be an authentication
   * *failure*, not a crash inside the login endpoint.
   */
  if (rawN === undefined || rawR === undefined || rawP === undefined) return false;
  if (rawSalt === undefined || rawHash === undefined) return false;

  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  const salt = Buffer.from(rawSalt, "hex");
  const expected = Buffer.from(rawHash, "hex");

  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false;
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = await scrypt(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: 128 * N * r * 2,
  });

  // Constant time. A `===` on the hex strings returns early at the first differing character, which
  // leaks — through response timing — how many leading bytes of the derived key were correct. It is
  // a small leak and a free fix, and there is no argument for not taking it.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Burn the same CPU as a real verification, then fail.
 *
 * Called when the email does not exist. Without it, "no such user" returns in ~1ms while "wrong
 * password" takes ~100ms — and that difference is a **user enumeration oracle**: an attacker can
 * discover exactly which email addresses have accounts, at scale, purely by timing the login
 * endpoint. Doing the work and throwing it away makes both paths cost the same.
 */
export async function fakeVerify(): Promise<void> {
  await scrypt("dummy-password", randomBytes(SALT_LENGTH), KEY_LENGTH, PARAMS);
}
