import { prisma } from "@/database/client.js";
import type { InvitationStatus, Role } from "@/generated/prisma/enums.js";
import { accessRepository } from "@/repositories/access.repository.js";
import { generateInviteToken, hashInviteToken } from "@/services/inviteToken.service.js";
import type { Actor } from "@/types/actor.js";
import { badRequest, forbidden, notFound } from "@/utils/errors.js";

/** Seven days. Long enough to survive a weekend inbox, short enough that a leaked link goes stale. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const INVITE_TTL_DAYS = 7;

export interface InvitationSummary {
  id: string;
  email: string;
  role: Role;
  status: InvitationStatus;
  createdAt: string;
  expiresAt: string;
}

/** What the invitee sees on the accept page. Deliberately reveals nothing about the document unless
 *  the signed-in email matches the invited one — a leaked link must not become a document-title oracle. */
export interface InvitationPreview {
  invitedEmail: string;
  /** PENDING | ACCEPTED | DECLINED | REVOKED, or EXPIRED when past `expiresAt`. */
  status: InvitationStatus | "EXPIRED";
  /** Whether the signed-in actor's email matches the invited address (a prerequisite to accept). */
  emailMatches: boolean;
  /** Present only when `emailMatches` — see the note above. */
  documentTitle: string | null;
  inviterName: string | null;
  role: Role | null;
}

/** Everything the route needs to send (or re-send) the invitation email. The raw token lives only here
 *  and in the email — it is never returned in an API response. */
export interface InvitationDispatch {
  token: string;
  email: string;
  role: Exclude<Role, "OWNER">;
  documentTitle: string;
  inviterName: string;
}

function toSummary(row: {
  id: string;
  email: string;
  role: Role;
  status: InvitationStatus;
  createdAt: Date;
  expiresAt: Date;
}): InvitationSummary {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

export const invitationRepository = {
  /**
   * Create (or refresh) a pending invitation and mint its link token.
   *
   * Only a manager (OWNER) may invite — enforced by `authorize(..., "manage")`. The invitee need not
   * have an account: the invitation is keyed by email, and existence is resolved at accept time. Two
   * early rejections keep the data honest: you cannot invite yourself, and you cannot invite someone
   * who already has access (that would be a no-op invitation cluttering the pending list).
   */
  async create(
    actor: Actor,
    documentId: string,
    email: string,
    role: Exclude<Role, "OWNER">,
  ): Promise<{ invitation: InvitationSummary; dispatch: InvitationDispatch }> {
    await accessRepository.authorize(actor, documentId, "manage");

    const normalized = email.trim().toLowerCase();
    if (normalized === actor.email.toLowerCase()) {
      throw badRequest("you already have access to this document");
    }

    // If the invitee already exists AND is already a collaborator, there is nothing to invite.
    const existingUser = await prisma.user.findFirst({
      where: { email: normalized, deletedAt: null },
      select: { id: true },
    });
    if (existingUser !== null) {
      const already = await prisma.collaborator.findUnique({
        where: { document_user: { documentId, userId: existingUser.id } },
        select: { id: true },
      });
      if (already !== null) throw badRequest("that person already has access to this document");
    }

    const token = generateInviteToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    // Re-inviting the same address refreshes the row: a new token (invalidating any old link), a fresh
    // expiry, and PENDING again even if a previous invite was declined or revoked.
    const invitation = await prisma.invitation.upsert({
      where: { document_email: { documentId, email: normalized } },
      create: {
        documentId,
        email: normalized,
        role,
        tokenHash: hashInviteToken(token),
        status: "PENDING",
        invitedById: actor.userId,
        expiresAt,
      },
      update: {
        role,
        tokenHash: hashInviteToken(token),
        status: "PENDING",
        invitedById: actor.userId,
        expiresAt,
        acceptedAt: null,
        acceptedById: null,
        revokedAt: null,
      },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
        expiresAt: true,
      },
    });

    const [document, inviter] = await Promise.all([
      prisma.document.findFirst({ where: { id: documentId }, select: { title: true } }),
      prisma.user.findFirst({ where: { id: actor.userId }, select: { name: true } }),
    ]);

    await prisma.auditLog.create({
      data: {
        action: "COLLABORATOR_INVITED",
        actorId: actor.userId,
        targetId: documentId,
        metadata: { email: normalized, role, invitationId: invitation.id },
      },
    });

    return {
      invitation: toSummary(invitation),
      dispatch: {
        token,
        email: normalized,
        role,
        documentTitle: document?.title ?? "a document",
        inviterName: inviter?.name ?? actor.email,
      },
    };
  },

  /** The pending invitations for a document — the "awaiting acceptance" list the owner sees. */
  async listPending(actor: Actor, documentId: string): Promise<InvitationSummary[]> {
    await accessRepository.authorize(actor, documentId, "manage");

    const rows = await prisma.invitation.findMany({
      where: { documentId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
        expiresAt: true,
      },
    });

    return rows.map(toSummary);
  },

  /** Cancel a pending invitation. Its token stops working immediately. */
  async revoke(actor: Actor, documentId: string, invitationId: string): Promise<void> {
    await accessRepository.authorize(actor, documentId, "manage");

    const updated = await prisma.invitation.updateMany({
      where: { id: invitationId, documentId, status: "PENDING" },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    if (updated.count === 0) throw notFound("invitation");

    await prisma.auditLog.create({
      data: {
        action: "INVITATION_REVOKED",
        actorId: actor.userId,
        targetId: documentId,
        metadata: { invitationId },
      },
    });
  },

  /** Re-send a pending invitation: fresh token, fresh expiry, and the dispatch payload to re-email. */
  async resend(
    actor: Actor,
    documentId: string,
    invitationId: string,
  ): Promise<InvitationDispatch> {
    await accessRepository.authorize(actor, documentId, "manage");

    const existing = await prisma.invitation.findFirst({
      where: { id: invitationId, documentId, status: "PENDING" },
      select: { email: true, role: true },
    });
    if (existing === null) throw notFound("invitation");

    const token = generateInviteToken();
    await prisma.invitation.update({
      where: { id: invitationId },
      data: { tokenHash: hashInviteToken(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
    });

    const [document, inviter] = await Promise.all([
      prisma.document.findFirst({ where: { id: documentId }, select: { title: true } }),
      prisma.user.findFirst({ where: { id: actor.userId }, select: { name: true } }),
    ]);

    return {
      token,
      email: existing.email,
      // A pending invitation never carries OWNER (invites are Exclude<Role,"OWNER">), but the column
      // type is Role; narrow it for the email helper.
      role: existing.role === "OWNER" ? "EDITOR" : existing.role,
      documentTitle: document?.title ?? "a document",
      inviterName: inviter?.name ?? actor.email,
    };
  },

  /**
   * What the invitee sees before accepting. Requires a signed-in actor (the accept page is reached
   * after login) but NOT document access — the whole point is that they are not a collaborator yet.
   *
   * The document title and inviter are withheld unless the actor's email matches the invited one, so a
   * link that leaked to the wrong (but authenticated) person reveals nothing but the address it was
   * sent to.
   */
  async preview(actor: Actor, token: string): Promise<InvitationPreview> {
    const invitation = await prisma.invitation.findUnique({
      where: { tokenHash: hashInviteToken(token) },
      select: {
        email: true,
        role: true,
        status: true,
        expiresAt: true,
        documentId: true,
        invitedById: true,
      },
    });
    if (invitation === null) throw notFound("invitation");

    const emailMatches = actor.email.toLowerCase() === invitation.email;
    const status: InvitationStatus | "EXPIRED" =
      invitation.status === "PENDING" && invitation.expiresAt.getTime() < Date.now()
        ? "EXPIRED"
        : invitation.status;

    if (!emailMatches) {
      return {
        invitedEmail: invitation.email,
        status,
        emailMatches: false,
        documentTitle: null,
        inviterName: null,
        role: null,
      };
    }

    const [document, inviter] = await Promise.all([
      prisma.document.findFirst({ where: { id: invitation.documentId }, select: { title: true } }),
      prisma.user.findFirst({ where: { id: invitation.invitedById }, select: { name: true } }),
    ]);

    return {
      invitedEmail: invitation.email,
      status,
      emailMatches: true,
      documentTitle: document?.title ?? "Untitled",
      inviterName: inviter?.name ?? null,
      role: invitation.role,
    };
  },

  /**
   * Accept an invitation: the only path that turns an invitation into a Collaborator row.
   *
   * Every guard here is load-bearing:
   *  - unknown token → 404 (not an oracle);
   *  - not PENDING / expired → the link is spent or stale;
   *  - **the signed-in email must equal the invited email** → a forwarded link cannot grant a
   *    different account access. This is the difference between "share with a person" and "share with
   *    whoever holds the URL".
   */
  async accept(actor: Actor, token: string): Promise<{ documentId: string }> {
    const invitation = await prisma.invitation.findUnique({
      where: { tokenHash: hashInviteToken(token) },
      select: {
        id: true,
        documentId: true,
        email: true,
        role: true,
        status: true,
        expiresAt: true,
        invitedById: true,
      },
    });
    if (invitation === null) throw notFound("invitation");

    if (invitation.status !== "PENDING") {
      throw badRequest("this invitation is no longer valid");
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      throw badRequest("this invitation has expired");
    }
    if (actor.email.toLowerCase() !== invitation.email) {
      throw forbidden("this invitation was sent to a different email address");
    }

    const role: Exclude<Role, "OWNER"> = invitation.role === "OWNER" ? "EDITOR" : invitation.role;

    await prisma.$transaction([
      // Upsert so accepting an invitation for a document you were re-added to just updates the role.
      prisma.collaborator.upsert({
        where: { document_user: { documentId: invitation.documentId, userId: actor.userId } },
        create: {
          documentId: invitation.documentId,
          userId: actor.userId,
          role,
          invitedById: invitation.invitedById,
        },
        update: { role },
      }),
      prisma.invitation.update({
        where: { id: invitation.id },
        data: { status: "ACCEPTED", acceptedById: actor.userId, acceptedAt: new Date() },
      }),
      prisma.auditLog.create({
        data: {
          action: "INVITATION_ACCEPTED",
          actorId: actor.userId,
          targetId: invitation.documentId,
          metadata: { invitationId: invitation.id, role },
        },
      }),
    ]);

    return { documentId: invitation.documentId };
  },

  /** Decline an invitation. Same email-match guard as accept — only the addressee may act on it. */
  async decline(actor: Actor, token: string): Promise<void> {
    const invitation = await prisma.invitation.findUnique({
      where: { tokenHash: hashInviteToken(token) },
      select: { id: true, documentId: true, email: true, status: true },
    });
    if (invitation === null) throw notFound("invitation");
    if (invitation.status !== "PENDING") throw badRequest("this invitation is no longer valid");
    if (actor.email.toLowerCase() !== invitation.email) {
      throw forbidden("this invitation was sent to a different email address");
    }

    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { status: "DECLINED" },
    });

    await prisma.auditLog.create({
      data: {
        action: "INVITATION_DECLINED",
        actorId: actor.userId,
        targetId: invitation.documentId,
        metadata: { invitationId: invitation.id },
      },
    });
  },
} as const;
