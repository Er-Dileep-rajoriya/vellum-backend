import { prisma } from "@/database/client.js";
import type { PrismaClient } from "@/generated/prisma/client.js";
import type { Actor, DocumentAction, DocumentAccess } from "@/types/actor.js";
import { can } from "@/types/actor.js";
import { forbidden, notFound } from "@/utils/errors.js";

type Db = Pick<PrismaClient, "collaborator">;

/**
 * The one place authorization happens.
 *
 * Every read and every write in the system funnels through `authorize()`. Not "should" — does:
 * no other repository exposes a method that accepts a bare documentId, so there is no path to a
 * document that does not pass through here first.
 *
 * The critical subtlety is the 404-vs-403 distinction, and it is easy to get backwards:
 *
 *   - Caller is not a collaborator at all  → 404. They must not learn the document exists.
 *     Returning 403 here turns a document id into an existence oracle: an attacker enumerating ids
 *     gets "403" for real private documents and "404" for imaginary ones, which is a map of every
 *     document in the system.
 *
 *   - Caller IS a collaborator but lacks the capability (a VIEWER pressing "delete") → 403.
 *     They already know the document exists — they can read it. Hiding it now would just be a
 *     confusing bug, and the honest error is the one that tells them what is actually wrong.
 */
export const accessRepository = {
  /** The caller's role on a document, or null if they have no relationship to it. */
  async find(actor: Actor, documentId: string, db: Db = prisma): Promise<DocumentAccess | null> {
    const collaborator = await db.collaborator.findUnique({
      where: { document_user: { documentId, userId: actor.userId } },
      select: {
        role: true,
        // Soft-deleted documents are invisible to everyone, including their owner's collaborator
        // row. Filtering here rather than at each call site means "deleted" cannot be forgotten.
        document: { select: { deletedAt: true } },
      },
    });

    if (collaborator === null) return null;
    if (collaborator.document.deletedAt !== null) return null;

    return { documentId, role: collaborator.role };
  },

  /**
   * Assert the actor may perform `action` on `documentId`, or throw.
   *
   * Returns the access record so callers get the role for free and never need a second query —
   * which matters, because this runs on the hot path of every operation push.
   */
  async authorize(
    actor: Actor,
    documentId: string,
    action: DocumentAction,
    db: Db = prisma,
  ): Promise<DocumentAccess> {
    const access = await accessRepository.find(actor, documentId, db);

    if (access === null) {
      // Not a collaborator (or the document is deleted, or it never existed — all indistinguishable
      // from the outside, which is the point).
      throw notFound("document");
    }

    if (!can(access.role, action)) {
      throw forbidden(`role ${access.role} cannot ${action} this document`);
    }

    return access;
  },
} as const;
