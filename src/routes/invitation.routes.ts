import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { env } from "@/config/env.js";
import { actorOf, requireAuth } from "@/middlewares/auth.middleware.js";
import { actorRateLimit } from "@/middlewares/rateLimit.middleware.js";
import { INVITE_TTL_DAYS, invitationRepository } from "@/repositories/invitation.repository.js";
import { sendInvitationEmail } from "@/services/email.service.js";
import { logger } from "@/utils/logger.js";

const DocumentIdParams = z.object({ id: z.string().min(1).max(64) });
const InviteBody = z.object({
  email: z.email(),
  role: z.enum(["EDITOR", "VIEWER"]),
});
// The token is a 256-bit base64url string (~43 chars); the bound is generous but not unbounded.
const TokenParams = z.object({ token: z.string().min(20).max(200) });

/** The frontend origin, for building invite links. Falls back to the first CORS origin, which is the
 *  frontend by construction (see DEPLOYMENT.md). */
function appUrl(): string {
  return env.APP_URL !== "" ? env.APP_URL : (env.CORS_ORIGINS[0] ?? "");
}

/**
 * Invitations.
 *
 * Two audiences, one plugin. The `/documents/:id/invitations` routes are the owner's side — create,
 * list, revoke, resend — and every one authorizes `manage` inside the repository (D-011). The
 * `/invitations/:token` routes are the *invitee's* side: they require authentication but NOT document
 * access, because the whole point is that the invitee is not a collaborator yet. Authorization there
 * is the token plus the email-match check in the repository.
 *
 * Sending email never fails the request. A created invitation is durable; if SES is briefly down the
 * owner sees the pending invite and can press "resend" — losing the row because the mail bounced would
 * be the worse outcome.
 */
export async function invitationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", actorRateLimit);

  // ── Owner side ────────────────────────────────────────────────────────────

  app.post("/documents/:id/invitations", async (request, reply) => {
    const actor = actorOf(request);
    const { id } = DocumentIdParams.parse(request.params);
    const { email, role } = InviteBody.parse(request.body);

    const { invitation, dispatch } = await invitationRepository.create(actor, id, email, role);

    const emailSent = await deliver(dispatch);
    return reply.status(201).send({ invitation, emailSent });
  });

  app.get("/documents/:id/invitations", async (request, reply) => {
    const actor = actorOf(request);
    const { id } = DocumentIdParams.parse(request.params);

    const invitations = await invitationRepository.listPending(actor, id);
    return reply.send({ invitations });
  });

  app.delete("/documents/:id/invitations/:invitationId", async (request, reply) => {
    const actor = actorOf(request);
    const params = DocumentIdParams.extend({
      invitationId: z.string().min(1).max(64),
    }).parse(request.params);

    await invitationRepository.revoke(actor, params.id, params.invitationId);
    return reply.status(204).send();
  });

  app.post("/documents/:id/invitations/:invitationId/resend", async (request, reply) => {
    const actor = actorOf(request);
    const params = DocumentIdParams.extend({
      invitationId: z.string().min(1).max(64),
    }).parse(request.params);

    const dispatch = await invitationRepository.resend(actor, params.id, params.invitationId);
    const emailSent = await deliver(dispatch);
    return reply.send({ emailSent });
  });

  // ── Invitee side ──────────────────────────────────────────────────────────

  app.get("/invitations/:token", async (request, reply) => {
    const actor = actorOf(request);
    const { token } = TokenParams.parse(request.params);

    const invitation = await invitationRepository.preview(actor, token);
    return reply.send({ invitation });
  });

  app.post("/invitations/:token/accept", async (request, reply) => {
    const actor = actorOf(request);
    const { token } = TokenParams.parse(request.params);

    const result = await invitationRepository.accept(actor, token);
    return reply.send(result);
  });

  app.post("/invitations/:token/decline", async (request, reply) => {
    const actor = actorOf(request);
    const { token } = TokenParams.parse(request.params);

    await invitationRepository.decline(actor, token);
    return reply.status(204).send();
  });
}

/** Send the invitation email; never throw. Returns whether it went out. */
async function deliver(dispatch: {
  token: string;
  email: string;
  role: "EDITOR" | "VIEWER";
  documentTitle: string;
  inviterName: string;
}): Promise<boolean> {
  try {
    await sendInvitationEmail(dispatch.email, {
      inviterName: dispatch.inviterName,
      documentTitle: dispatch.documentTitle,
      role: dispatch.role,
      acceptUrl: `${appUrl()}/invite/${dispatch.token}`,
      expiresInDays: INVITE_TTL_DAYS,
    });
    return true;
  } catch (cause) {
    logger.error({ err: cause, to: dispatch.email }, "invitation email failed");
    return false;
  }
}
