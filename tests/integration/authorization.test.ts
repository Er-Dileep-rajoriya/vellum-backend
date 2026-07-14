import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { accessRepository } from "@/repositories/access.repository.js";
import { collaboratorRepository } from "@/repositories/collaborator.repository.js";
import { documentRepository } from "@/repositories/document.repository.js";
import type { Role } from "@/generated/prisma/enums.js";
import type { Actor, DocumentAction } from "@/types/actor.js";
import { isAppError } from "@/utils/errors.js";

import {
  addCollaborator,
  createDocument,
  createUser,
  migrateTestDatabase,
  resetDatabase,
} from "../helpers/db.js";

/**
 * The authorization matrix, tested exhaustively rather than representatively.
 *
 * Every (role × action) pair is asserted — including the ones that "obviously" work — because an
 * authorization bug is not found by testing the interesting cases. It is found by testing the
 * boring case that someone changed six months later while adding a feature. There are 15 pairs plus
 * the stranger, so exhaustive costs nothing and is the only version of this test that stays true.
 */

const ROLES: readonly Role[] = ["OWNER", "EDITOR", "VIEWER"];
const ACTIONS: readonly DocumentAction[] = ["read", "write", "restore", "manage", "delete"];

/** The specification, written out longhand. If a permission changes, it changes HERE, visibly. */
const EXPECTED: Record<Role, Record<DocumentAction, boolean>> = {
  OWNER: { read: true, write: true, restore: true, manage: true, delete: true },
  EDITOR: { read: true, write: true, restore: true, manage: false, delete: false },
  // The requirement from the brief: a viewer cannot edit, sync, restore, or delete.
  // "write" is both edit and sync — they are the same capability, separated only by time.
  VIEWER: { read: true, write: false, restore: false, manage: false, delete: false },
};

describe("authorization matrix", () => {
  beforeAll(() => {
    migrateTestDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  for (const role of ROLES) {
    for (const action of ACTIONS) {
      const allowed = EXPECTED[role][action];

      it(`${role} ${allowed ? "CAN" : "CANNOT"} ${action}`, async () => {
        const owner = await createUser("Owner");
        const documentId = await createDocument(owner);

        let actor: Actor = owner;
        if (role !== "OWNER") {
          actor = await createUser(role);
          await addCollaborator(documentId, actor, role);
        }

        if (allowed) {
          await expect(
            accessRepository.authorize(actor, documentId, action),
          ).resolves.toMatchObject({ role });
          return;
        }

        // Denied to a *known* collaborator must be 403, never 404: they can already see the
        // document, so hiding it would be a lie that helps nobody.
        await expect(accessRepository.authorize(actor, documentId, action)).rejects.toSatisfy(
          (error: unknown) => isAppError(error) && error.code === "FORBIDDEN",
        );
      });
    }
  }

  /**
   * The enumeration-oracle test.
   *
   * A stranger must get 404 — NOT 403 — for every action, including `read`. A 403 would confirm the
   * document exists, which turns an id enumeration into a map of every private document in the
   * system. This is the single most valuable test in this file, and the behaviour it protects is
   * the one most likely to be "fixed" into a 403 by someone who thinks 404 is a bug.
   */
  for (const action of ACTIONS) {
    it(`a stranger gets NOT_FOUND (never FORBIDDEN) for ${action} — no existence oracle`, async () => {
      const owner = await createUser("Owner");
      const stranger = await createUser("Stranger");
      const documentId = await createDocument(owner);

      await expect(accessRepository.authorize(stranger, documentId, action)).rejects.toSatisfy(
        (error: unknown) => isAppError(error) && error.code === "NOT_FOUND",
      );
    });
  }

  it("a soft-deleted document is invisible even to its owner", async () => {
    const owner = await createUser("Owner");
    const documentId = await createDocument(owner);

    await documentRepository.softDelete(owner, documentId);

    await expect(accessRepository.authorize(owner, documentId, "read")).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === "NOT_FOUND",
    );
    await expect(documentRepository.listForActor(owner)).resolves.toHaveLength(0);
  });

  it("a soft-deleted document can be restored by its owner, and remains intact", async () => {
    const owner = await createUser("Owner");
    const documentId = await createDocument(owner, "Important");

    await documentRepository.softDelete(owner, documentId);
    await documentRepository.restore(owner, documentId);

    const document = await documentRepository.findForActor(owner, documentId);
    expect(document.title).toBe("Important");
  });

  it("listForActor returns owned and shared documents through one code path", async () => {
    const owner = await createUser("Owner");
    const editor = await createUser("Editor");

    const owned = await documentRepository.create(editor, "Mine");
    const shared = await createDocument(owner, "Theirs");
    await addCollaborator(shared, editor, "EDITOR");

    const documents = await documentRepository.listForActor(editor);
    const byId = new Map(documents.map((d) => [d.id, d]));

    expect(byId.get(owned.id)?.role).toBe("OWNER");
    expect(byId.get(shared)?.role).toBe("EDITOR");
    expect(documents).toHaveLength(2);
  });
});

describe("collaborator management", () => {
  beforeAll(() => {
    migrateTestDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it("an editor cannot invite collaborators (manage is owner-only)", async () => {
    const owner = await createUser("Owner");
    const editor = await createUser("Editor");
    const outsider = await createUser("Outsider");
    const documentId = await createDocument(owner);
    await addCollaborator(documentId, editor, "EDITOR");

    await expect(
      collaboratorRepository.invite(editor, documentId, outsider.email, "VIEWER"),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === "FORBIDDEN");
  });

  it("re-inviting an existing collaborator updates their role instead of failing", async () => {
    const owner = await createUser("Owner");
    const guest = await createUser("Guest");
    const documentId = await createDocument(owner);

    await collaboratorRepository.invite(owner, documentId, guest.email, "VIEWER");
    const promoted = await collaboratorRepository.invite(owner, documentId, guest.email, "EDITOR");

    expect(promoted.role).toBe("EDITOR");
    const collaborators = await collaboratorRepository.list(owner, documentId);
    expect(collaborators).toHaveLength(2); // owner + guest, not owner + guest + guest
  });

  it("the owner's role cannot be changed — it would orphan the document", async () => {
    const owner = await createUser("Owner");
    const documentId = await createDocument(owner);

    await expect(
      collaboratorRepository.changeRole(owner, documentId, owner.userId, "VIEWER"),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === "BAD_REQUEST");
  });

  it("the owner cannot leave their own document", async () => {
    const owner = await createUser("Owner");
    const documentId = await createDocument(owner);

    await expect(
      collaboratorRepository.remove(owner, documentId, owner.userId),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === "FORBIDDEN");
  });

  it("a viewer can remove themselves without the manage permission", async () => {
    const owner = await createUser("Owner");
    const viewer = await createUser("Viewer");
    const documentId = await createDocument(owner);
    await addCollaborator(documentId, viewer, "VIEWER");

    await collaboratorRepository.remove(viewer, documentId, viewer.userId);

    await expect(accessRepository.find(viewer, documentId)).resolves.toBeNull();
  });

  it("a viewer cannot remove someone else", async () => {
    const owner = await createUser("Owner");
    const viewer = await createUser("Viewer");
    const editor = await createUser("Editor");
    const documentId = await createDocument(owner);
    await addCollaborator(documentId, viewer, "VIEWER");
    await addCollaborator(documentId, editor, "EDITOR");

    await expect(
      collaboratorRepository.remove(viewer, documentId, editor.userId),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === "FORBIDDEN");
  });
});
