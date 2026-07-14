import { prisma } from "@/database/client.js";
import type { Role } from "@/generated/prisma/enums.js";
import { accessRepository } from "@/repositories/access.repository.js";
import type { Actor } from "@/types/actor.js";
import { badRequest, forbidden, notFound } from "@/utils/errors.js";

export interface CollaboratorSummary {
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
  role: Role;
  createdAt: string;
}

export const collaboratorRepository = {
  async list(actor: Actor, documentId: string): Promise<CollaboratorSummary[]> {
    await accessRepository.authorize(actor, documentId, "read");

    const rows = await prisma.collaborator.findMany({
      where: { documentId },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
      select: {
        role: true,
        createdAt: true,
        user: { select: { id: true, email: true, name: true, image: true } },
      },
    });

    return rows.map((row) => ({
      userId: row.user.id,
      email: row.user.email,
      name: row.user.name,
      image: row.user.image,
      role: row.role,
      createdAt: row.createdAt.toISOString(),
    }));
  },

  /**
   * Invite by email.
   *
   * Two guards that look like edge cases and are not:
   *
   *  - **You cannot invite someone as OWNER.** Ownership is transferred, never granted, and a
   *    second OWNER row would make `documents.ownerId` disagree with the collaborator table —
   *    two sources of truth for the same fact, which is how "the owner can't delete their own
   *    document" bugs are born.
   *
   *  - **Re-inviting an existing collaborator updates their role** rather than throwing. The UI
   *    calls this from a role dropdown, and making the caller distinguish invite-from-change is
   *    an API that will be got wrong.
   */
  async invite(
    actor: Actor,
    documentId: string,
    email: string,
    role: Exclude<Role, "OWNER">,
  ): Promise<CollaboratorSummary> {
    await accessRepository.authorize(actor, documentId, "manage");

    const invitee = await prisma.user.findFirst({
      where: { email: email.toLowerCase(), deletedAt: null },
      select: { id: true, email: true, name: true, image: true },
    });
    // Deliberately a 404 on the *user*, not a silent success. An "invite anyone by email and we'll
    // create a shell account" flow is a spam vector and an account-enumeration surface; inviting a
    // real user is the only supported path.
    if (invitee === null) throw notFound("user");

    const collaborator = await prisma.collaborator.upsert({
      where: { document_user: { documentId, userId: invitee.id } },
      create: { documentId, userId: invitee.id, role, invitedById: actor.userId },
      update: { role },
      select: { role: true, createdAt: true },
    });

    await prisma.auditLog.create({
      data: {
        action: "COLLABORATOR_INVITED",
        actorId: actor.userId,
        targetId: documentId,
        metadata: { inviteeId: invitee.id, role },
      },
    });

    return {
      userId: invitee.id,
      email: invitee.email,
      name: invitee.name,
      image: invitee.image,
      role: collaborator.role,
      createdAt: collaborator.createdAt.toISOString(),
    };
  },

  async changeRole(
    actor: Actor,
    documentId: string,
    userId: string,
    role: Exclude<Role, "OWNER">,
  ): Promise<void> {
    await accessRepository.authorize(actor, documentId, "manage");

    const document = await prisma.document.findFirst({
      where: { id: documentId },
      select: { ownerId: true },
    });
    if (document === null) throw notFound("document");

    // Demoting the owner would leave a document that nobody can manage — including the person who
    // created it. There is no recovery path for that from inside the product.
    if (document.ownerId === userId) {
      throw badRequest("the owner's role cannot be changed; transfer ownership instead");
    }

    const updated = await prisma.collaborator.updateMany({
      where: { documentId, userId },
      data: { role },
    });
    if (updated.count === 0) throw notFound("collaborator");

    await prisma.auditLog.create({
      data: {
        action: "COLLABORATOR_ROLE_CHANGED",
        actorId: actor.userId,
        targetId: documentId,
        metadata: { userId, role },
      },
    });
  },

  /**
   * Remove a collaborator — or leave a document yourself.
   *
   * Self-removal is allowed without `manage`: a user must always be able to walk away from a
   * document someone shared with them. The owner cannot leave (they would orphan the document);
   * they delete or transfer it instead.
   */
  async remove(actor: Actor, documentId: string, userId: string): Promise<void> {
    const isSelfRemoval = userId === actor.userId;

    if (isSelfRemoval) {
      const access = await accessRepository.authorize(actor, documentId, "read");
      if (access.role === "OWNER") {
        throw forbidden("the owner cannot leave their own document; delete or transfer it");
      }
    } else {
      await accessRepository.authorize(actor, documentId, "manage");

      const document = await prisma.document.findFirst({
        where: { id: documentId },
        select: { ownerId: true },
      });
      if (document === null) throw notFound("document");
      if (document.ownerId === userId) throw badRequest("the owner cannot be removed");
    }

    const deleted = await prisma.collaborator.deleteMany({ where: { documentId, userId } });
    if (deleted.count === 0) throw notFound("collaborator");

    await prisma.auditLog.create({
      data: {
        action: "COLLABORATOR_REMOVED",
        actorId: actor.userId,
        targetId: documentId,
        metadata: { userId, selfRemoval: isSelfRemoval },
      },
    });
  },
} as const;
