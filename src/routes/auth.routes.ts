import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { prisma } from "@/database/client.js";
import { requireServiceToken } from "@/middlewares/auth.middleware.js";
import { fakeVerify, hashPassword, verifyPassword } from "@/services/password.service.js";
import { badRequest, unauthenticated } from "@/utils/errors.js";
import { logger } from "@/utils/logger.js";

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

    return reply.status(201).send({ user });
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
      select: { id: true, email: true, name: true, image: true, passwordHash: true },
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
}
