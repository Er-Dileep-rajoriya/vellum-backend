import { prisma } from "@/database/client.js";
import type { Role } from "@/generated/prisma/enums.js";
import { accessRepository } from "@/repositories/access.repository.js";
import type { Actor } from "@/types/actor.js";
import { notFound } from "@/utils/errors.js";

export interface DocumentSummary {
  id: string;
  title: string;
  role: Role;
  ownerId: string;
  ownerName: string | null;
  serverSeq: string;
  snapshotSeq: string;
  collaboratorCount: number;
  updatedAt: string;
  createdAt: string;
}

export const documentRepository = {
  /**
   * Documents the actor can see.
   *
   * Note what is absent: there is no `where: { ownerId }` OR `where: { id: { in: sharedIds } }`
   * two-query union. Ownership is *modelled* as a Collaborator row with role OWNER (created in the
   * same transaction as the document), so "documents I can see" is exactly "documents I collaborate
   * on" — one index-backed query, and no possibility of the two branches drifting apart such that a
   * document appears in one list and not the other.
   */
  async listForActor(actor: Actor, limit = 50, cursor?: string): Promise<DocumentSummary[]> {
    const rows = await prisma.collaborator.findMany({
      where: {
        userId: actor.userId,
        document: { deletedAt: null },
      },
      orderBy: { document: { updatedAt: "desc" } },
      take: limit,
      ...(cursor !== undefined ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        role: true,
        document: {
          select: {
            id: true,
            title: true,
            ownerId: true,
            serverSeq: true,
            snapshotSeq: true,
            createdAt: true,
            updatedAt: true,
            owner: { select: { name: true } },
            _count: { select: { collaborators: true } },
          },
        },
      },
    });

    return rows.map(({ role, document }) => ({
      id: document.id,
      title: document.title,
      role,
      ownerId: document.ownerId,
      ownerName: document.owner.name,
      serverSeq: document.serverSeq.toString(),
      snapshotSeq: document.snapshotSeq.toString(),
      collaboratorCount: document._count.collaborators,
      createdAt: document.createdAt.toISOString(),
      updatedAt: document.updatedAt.toISOString(),
    }));
  },

  /** Read one document. Throws 404 if the actor is not a collaborator — see access.repository. */
  async findForActor(actor: Actor, documentId: string): Promise<DocumentSummary> {
    const access = await accessRepository.authorize(actor, documentId, "read");

    const document = await prisma.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: {
        id: true,
        title: true,
        ownerId: true,
        serverSeq: true,
        snapshotSeq: true,
        createdAt: true,
        updatedAt: true,
        owner: { select: { name: true } },
        _count: { select: { collaborators: true } },
      },
    });
    if (document === null) throw notFound("document");

    return {
      id: document.id,
      title: document.title,
      role: access.role,
      ownerId: document.ownerId,
      ownerName: document.owner.name,
      serverSeq: document.serverSeq.toString(),
      snapshotSeq: document.snapshotSeq.toString(),
      collaboratorCount: document._count.collaborators,
      createdAt: document.createdAt.toISOString(),
      updatedAt: document.updatedAt.toISOString(),
    };
  },

  /**
   * Create a document and its owner Collaborator row **in one transaction**.
   *
   * If these could ever be separate, a crash between them would produce a document that its own
   * creator cannot open — unreachable by every query in the system, since every query goes through
   * `collaborators`. That is not a hypothetical: it is the single most common way an
   * ownership-as-a-column-plus-a-join-table design corrupts itself.
   */
  async create(actor: Actor, title: string): Promise<DocumentSummary> {
    const document = await prisma.$transaction(async (tx) => {
      const created = await tx.document.create({
        data: {
          title,
          ownerId: actor.userId,
          collaborators: {
            create: { userId: actor.userId, role: "OWNER" },
          },
        },
        select: {
          id: true,
          title: true,
          ownerId: true,
          serverSeq: true,
          snapshotSeq: true,
          createdAt: true,
          updatedAt: true,
          owner: { select: { name: true } },
        },
      });

      await tx.auditLog.create({
        data: {
          action: "DOCUMENT_CREATED",
          actorId: actor.userId,
          targetId: created.id,
        },
      });

      return created;
    });

    return {
      id: document.id,
      title: document.title,
      role: "OWNER",
      ownerId: document.ownerId,
      ownerName: document.owner.name,
      serverSeq: document.serverSeq.toString(),
      snapshotSeq: document.snapshotSeq.toString(),
      collaboratorCount: 1,
      createdAt: document.createdAt.toISOString(),
      updatedAt: document.updatedAt.toISOString(),
    };
  },

  async rename(actor: Actor, documentId: string, title: string): Promise<void> {
    await accessRepository.authorize(actor, documentId, "manage");
    await prisma.document.update({ where: { id: documentId }, data: { title } });
  },

  /**
   * Soft delete.
   *
   * The operation log and version history survive untouched. "Delete" in a document product means
   * "make it go away", not "destroy the only copy of something a user spent three months writing" —
   * and every support team on earth eventually needs to undo one of these.
   */
  async softDelete(actor: Actor, documentId: string): Promise<void> {
    await accessRepository.authorize(actor, documentId, "delete");

    await prisma.$transaction([
      prisma.document.update({
        where: { id: documentId },
        data: { deletedAt: new Date() },
      }),
      prisma.auditLog.create({
        data: { action: "DOCUMENT_DELETED", actorId: actor.userId, targetId: documentId },
      }),
    ]);
  },

  /** Undelete. Only the owner can, and it is audited. */
  async restore(actor: Actor, documentId: string): Promise<void> {
    // `authorize` filters out soft-deleted documents by design, so it cannot be used here: the
    // whole point is to act on a deleted one. Ownership is therefore checked directly, and *only*
    // ownership — this is the one deliberate exception to the "everything goes through
    // accessRepository" rule, and it is narrow: it grants nothing to anyone who is not the owner.
    const document = await prisma.document.findFirst({
      where: { id: documentId, ownerId: actor.userId, deletedAt: { not: null } },
      select: { id: true },
    });
    if (document === null) throw notFound("document");

    await prisma.$transaction([
      prisma.document.update({ where: { id: documentId }, data: { deletedAt: null } }),
      prisma.auditLog.create({
        data: { action: "DOCUMENT_RESTORED", actorId: actor.userId, targetId: documentId },
      }),
    ]);
  },
} as const;
