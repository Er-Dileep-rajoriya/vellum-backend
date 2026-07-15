import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { prisma } from "@/database/client.js";
import { requireServiceToken } from "@/middlewares/auth.middleware.js";
import { sendPasswordResetEmail, sendVerificationEmail } from "@/services/email.service.js";
import { generateOtp, hashOtp, verifyOtp } from "@/services/otp.service.js";
import { fakeVerify, hashPassword, verifyPassword } from "@/services/password.service.js";
import { badRequest, forbidden, unauthenticated } from "@/utils/errors.js";
import { logger } from "@/utils/logger.js";

/** How long a code is valid. Short on purpose: the whole point of a one-time code is that it dies. */
const OTP_TTL_MS = 10 * 60 * 1000;
/** Wrong guesses before the code is dead. This cap — not the code length — is what defeats brute force. */
const MAX_OTP_ATTEMPTS = 5;
/** Minimum gap between two sends to the same address+purpose. Stops the endpoint being an email cannon. */
const RESEND_COOLDOWN_MS = 60 * 1000;

type OtpPurpose = "EMAIL_VERIFY" | "PASSWORD_RESET";

/**
 * Mint a fresh code for (email, purpose), invalidating any earlier one, and hand back the plaintext
 * code for the caller to email. The code is stored only as a keyed HMAC; this return value is the
 * one and only time the plaintext exists outside the user's inbox.
 *
 * Throttled: a second request inside the cooldown throws, so a script cannot walk this into a flood
 * of mail (which is both a cost and a fast way to get the sending domain blocklisted).
 */
async function issueOtp(email: string, purpose: OtpPurpose): Promise<string> {
  const last = await prisma.verificationToken.findFirst({
    where: { email, purpose, consumedAt: null },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  if (last !== null && Date.now() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    throw badRequest("please wait a moment before requesting another code");
  }

  const code = generateOtp();

  // One live code per (email, purpose): drop the old ones so a previously-sent code cannot be used
  // after a new one is requested, and the "latest unconsumed" lookup at verify time is unambiguous.
  await prisma.verificationToken.deleteMany({ where: { email, purpose, consumedAt: null } });
  await prisma.verificationToken.create({
    data: {
      email,
      purpose,
      codeHash: hashOtp(code),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    },
  });

  return code;
}

type ConsumeResult = "ok" | "invalid" | "expired" | "too_many" | "not_found";

/**
 * Check a presented code and, on success, consume it (single use). Every failure mode is distinct so
 * the route can tell the user something actionable — "wrong code" vs "expired, request a new one" —
 * without ever revealing the code itself.
 *
 * A wrong guess increments `attempts`; at the cap the code is spent even though nobody got it right.
 * That is the online brute-force ceiling: a 6-digit code cannot be walked in more than a handful of
 * tries before it dies and the user must request a fresh one.
 */
async function consumeOtp(email: string, purpose: OtpPurpose, code: string): Promise<ConsumeResult> {
  const token = await prisma.verificationToken.findFirst({
    where: { email, purpose, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (token === null) return "not_found";
  if (token.expiresAt.getTime() < Date.now()) return "expired";
  if (token.attempts >= MAX_OTP_ATTEMPTS) return "too_many";

  if (!verifyOtp(code, token.codeHash)) {
    await prisma.verificationToken.update({
      where: { id: token.id },
      data: { attempts: { increment: 1 } },
    });
    return "invalid";
  }

  await prisma.verificationToken.update({
    where: { id: token.id },
    data: { consumedAt: new Date() },
  });
  return "ok";
}

/** Map a non-ok consume result to a client-safe error. `ok` never reaches here. */
function otpError(result: Exclude<ConsumeResult, "ok">): never {
  switch (result) {
    case "invalid":
      throw badRequest("that code is not correct");
    case "too_many":
      throw badRequest("too many attempts — request a new code");
    case "expired":
    case "not_found":
      throw badRequest("that code has expired — request a new one");
  }
}

/**
 * The user endpoints.
 *
 * These exist because the frontend has **no database access** (DECISIONS.md D-001b). Auth.js runs in
 * Next.js and owns the *session*; it does not own the *user*. When someone signs up or signs in with
 * Google, Auth.js calls these endpoints with the shared service token, and Postgres stays behind
 * exactly one process.
 *
 * The service token is powerful — it can mint users — so it is scoped to these routes and nothing
 * else, and it never produces an `Actor`. A caller holding it is not "logged in as" anybody and
 * cannot use it to reach a document.
 */

const RegisterSchema = z
  .object({
    email: z.email().max(254),
    name: z.string().trim().min(1).max(100).optional(),
    // 12 characters, not 8. Length is the only property of a password that reliably resists an
    // offline attack against a stolen hash; complexity rules mostly produce "P@ssw0rd1".
    password: z.string().min(12).max(200),
  })
  .strict();

const LoginSchema = z
  .object({
    email: z.email().max(254),
    password: z.string().min(1).max(200),
  })
  .strict();

const OAuthSchema = z
  .object({
    email: z.email().max(254),
    name: z.string().trim().max(100).optional(),
    image: z.url().max(2_048).optional(),
    provider: z.string().min(1).max(32),
    providerAccountId: z.string().min(1).max(128),
  })
  .strict();

const EmailSchema = z.object({ email: z.email().max(254) }).strict();

// A code is exactly six digits. Validating the shape here means a garbage code is a 400 before it
// ever touches an HMAC or a database row.
const OtpCode = z.string().regex(/^\d{6}$/, "code must be six digits");

const ConfirmSchema = z.object({ email: z.email().max(254), code: OtpCode }).strict();

const ResetSchema = z
  .object({
    email: z.email().max(254),
    code: OtpCode,
    password: z.string().min(12).max(200),
  })
  .strict();

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Every route here requires the service token. It is checked once, at the plugin boundary, so a
  // route added later cannot forget it.
  app.addHook("preHandler", requireServiceToken);

  app.post("/internal/users/register", async (request, reply) => {
    const body = RegisterSchema.parse(request.body);
    const email = body.email.toLowerCase();

    const existing = await prisma.user.findUnique({
      where: { email },
      select: { id: true, passwordHash: true },
    });

    /**
     * An existing user is a 409 — and that is a deliberate, considered leak.
     *
     * It DOES confirm that an email has an account. The alternative (always return success, send a
     * "someone tried to register with your address" email) is what a bank does, and it makes the
     * signup flow strictly worse for the 99.9% of users who simply forgot they already had an
     * account. Registration enumeration is also mostly unavoidable: any signup form that rejects
     * duplicates reveals the same fact.
     *
     * The place where enumeration genuinely matters is *login*, and that path is hardened (see
     * below): it returns the same error and burns the same CPU whether or not the user exists.
     */
    if (existing !== null) {
      // ...with one exception. A user who signed up with Google and now wants a password is not a
      // duplicate — they are the same person adding a credential. Attach it.
      if (existing.passwordHash === null) {
        const passwordHash = await hashPassword(body.password);
        await prisma.user.update({
          where: { id: existing.id },
          data: { passwordHash, ...(body.name !== undefined ? { name: body.name } : {}) },
        });
        return reply.status(200).send({ user: { id: existing.id, email } });
      }

      throw badRequest("an account with this email already exists");
    }

    const passwordHash = await hashPassword(body.password);

    const user = await prisma.user.create({
      data: { email, name: body.name ?? null, passwordHash },
      select: { id: true, email: true, name: true, image: true },
    });

    await prisma.auditLog.create({
      data: { action: "AUTH_LOGIN_SUCCEEDED", actorId: user.id, metadata: { via: "register" } },
    });

    // The account exists but is unverified: emailVerified stays null and login is refused (see the
    // gate in /verify) until the user confirms the code we send now. A send failure must not roll
    // back the account — the user can ask for a fresh code from the verify screen — so it is logged
    // and swallowed rather than turned into a 500 that loses the registration.
    try {
      const code = await issueOtp(email, "EMAIL_VERIFY");
      await sendVerificationEmail(email, code);
    } catch (cause) {
      logger.error({ err: cause, userId: user.id }, "verification email send failed at register");
    }

    return reply.status(201).send({ user, emailVerified: false });
  });

  /**
   * Verify credentials. Called from Auth.js's Credentials provider.
   *
   * The two enumeration defences here are the whole point of the endpoint:
   *
   *   1. **The same error, always.** "No such user" and "wrong password" both return 401 with an
   *      identical message. Distinguishing them tells an attacker which of a million leaked email
   *      addresses have accounts here.
   *   2. **The same latency, always.** A missing user still pays for a full scrypt hash
   *      (`fakeVerify`). Without it, "no such user" returns in ~1ms and "wrong password" in ~100ms —
   *      and the timing difference IS the oracle, no error message required.
   */
  app.post("/internal/users/verify", async (request, reply) => {
    const body = LoginSchema.parse(request.body);
    const email = body.email.toLowerCase();

    const user = await prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: { id: true, email: true, name: true, image: true, passwordHash: true, emailVerified: true },
    });

    if (user === null || user.passwordHash === null) {
      // Burn the CPU we would have burned on a real verification, then fail identically.
      await fakeVerify();

      await prisma.auditLog.create({
        data: {
          action: "AUTH_LOGIN_FAILED",
          metadata: { email, reason: "no_such_user" },
          ipAddress: request.ip,
        },
      });

      throw unauthenticated("invalid email or password");
    }

    const valid = await verifyPassword(body.password, user.passwordHash);

    if (!valid) {
      await prisma.auditLog.create({
        data: {
          action: "AUTH_LOGIN_FAILED",
          actorId: user.id,
          metadata: { reason: "bad_password" },
          ipAddress: request.ip,
        },
      });

      // Byte-for-byte the same error as above. This is not laziness; it is the control.
      throw unauthenticated("invalid email or password");
    }

    /**
     * The password is correct but the address was never confirmed. Refuse the login and say why —
     * this is NOT an enumeration leak: the caller already proved they know the password, so telling
     * them "verify your email" reveals nothing to an attacker who does not. The distinct `reason`
     * lets the frontend route them to the verify screen (and resend a code) instead of showing the
     * generic "invalid email or password".
     */
    if (user.emailVerified === null) {
      throw forbidden("email not verified");
    }

    await prisma.auditLog.create({
      data: { action: "AUTH_LOGIN_SUCCEEDED", actorId: user.id, ipAddress: request.ip },
    });

    return reply.send({
      user: { id: user.id, email: user.email, name: user.name, image: user.image },
    });
  });

  /**
   * Upsert an OAuth identity. Called from Auth.js's `signIn` callback after Google verifies the user.
   *
   * The join key is the **verified email**, which is what makes "sign up with a password, later sign
   * in with Google" resolve to one person rather than two accounts holding half a document library
   * each. This is only safe because the provider verified the address — an unverified email as a join
   * key would be an account-takeover primitive (register with victim@example.com at a sloppy OAuth
   * provider, then inherit their account here).
   */
  app.post("/internal/users/oauth", async (request, reply) => {
    const body = OAuthSchema.parse(request.body);
    const email = body.email.toLowerCase();

    const user = await prisma.user.upsert({
      where: { email },
      create: {
        email,
        name: body.name ?? null,
        image: body.image ?? null,
        emailVerified: new Date(),
      },
      // Do NOT overwrite a name the user has set in-product with whatever Google currently returns.
      // Only fill in what is missing.
      update: {
        ...(body.image !== undefined ? { image: body.image } : {}),
        emailVerified: new Date(),
      },
      select: { id: true, email: true, name: true, image: true },
    });

    await prisma.account.upsert({
      where: {
        provider_account: {
          provider: body.provider,
          providerAccountId: body.providerAccountId,
        },
      },
      create: {
        userId: user.id,
        provider: body.provider,
        providerAccountId: body.providerAccountId,
        type: "oauth",
      },
      update: {},
    });

    await prisma.auditLog.create({
      data: {
        action: "AUTH_LOGIN_SUCCEEDED",
        actorId: user.id,
        metadata: { via: body.provider },
        ipAddress: request.ip,
      },
    });

    logger.debug({ userId: user.id, provider: body.provider }, "oauth sign-in");

    return reply.send({ user });
  });

  /**
   * (Re)send an email-verification code. Used by the verify screen's "resend" button.
   *
   * Only sends to an account that exists and is not already verified — but returns the same `{ ok }`
   * either way. Registration already reveals whether an email is taken (see the 409 above), so this
   * endpoint does not need to defend enumeration; the uniform response just keeps the client simple.
   * Already-verified addresses get nothing, so a stranger cannot use this to spam a verified inbox.
   */
  app.post("/internal/auth/verify-email/send", async (request, reply) => {
    const body = EmailSchema.parse(request.body);
    const email = body.email.toLowerCase();

    const user = await prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: { emailVerified: true },
    });

    if (user !== null && user.emailVerified === null) {
      const code = await issueOtp(email, "EMAIL_VERIFY");
      await sendVerificationEmail(email, code);
    }

    return reply.send({ ok: true });
  });

  /** Confirm an email-verification code. On success the address is marked verified and login opens. */
  app.post("/internal/auth/verify-email/confirm", async (request, reply) => {
    const body = ConfirmSchema.parse(request.body);
    const email = body.email.toLowerCase();

    const result = await consumeOtp(email, "EMAIL_VERIFY", body.code);
    if (result !== "ok") otpError(result);

    // updateMany, not update: it is keyed by the unique email but tolerates the (impossible-by-now)
    // case of no matching row without throwing, and it never touches a soft-deleted account.
    await prisma.user.updateMany({
      where: { email, deletedAt: null },
      data: { emailVerified: new Date() },
    });

    return reply.send({ ok: true });
  });

  /**
   * Begin a password reset. Sends a code — but ONLY to an address that has a real, password-backed,
   * non-deleted account — and ALWAYS returns `{ ok: true }`.
   *
   * The uniform response is the enumeration defence that matters most: unlike registration, a reset
   * form is something an attacker points a list of a million leaked addresses at, and a different
   * response for "no account" vs "sent" would confirm which of them are real. So the response is
   * identical whether we sent anything or not. (An OAuth-only account with no password is treated
   * like "no account" here — there is no password to reset.)
   */
  app.post("/internal/auth/password/forgot", async (request, reply) => {
    const body = EmailSchema.parse(request.body);
    const email = body.email.toLowerCase();

    const user = await prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: { passwordHash: true },
    });

    if (user !== null && user.passwordHash !== null) {
      try {
        const code = await issueOtp(email, "PASSWORD_RESET");
        await sendPasswordResetEmail(email, code);
      } catch (cause) {
        // Swallow: a send failure (or the resend cooldown) must not change the response, or the
        // timing/shape of the failure becomes the very oracle the uniform 200 exists to prevent.
        logger.error({ err: cause, email }, "password reset email send failed");
      }
    }

    return reply.send({ ok: true });
  });

  /**
   * Complete a password reset: verify the code, set the new password.
   *
   * Verifying the code also proves the requester controls the inbox, so this doubles as email
   * verification — we set `emailVerified` here too, which lets a user who abandoned sign-up recover
   * straight into a working account.
   */
  app.post("/internal/auth/password/reset", async (request, reply) => {
    const body = ResetSchema.parse(request.body);
    const email = body.email.toLowerCase();

    const result = await consumeOtp(email, "PASSWORD_RESET", body.code);
    if (result !== "ok") otpError(result);

    const passwordHash = await hashPassword(body.password);
    const updated = await prisma.user.updateMany({
      where: { email, deletedAt: null },
      data: { passwordHash, emailVerified: new Date() },
    });

    // The code verified but the account is gone (deleted between request and reset). Treat as an
    // expired code rather than leaking that the account no longer exists.
    if (updated.count === 0) otpError("expired");

    logger.debug({ email }, "password reset");

    return reply.send({ ok: true });
  });
}
