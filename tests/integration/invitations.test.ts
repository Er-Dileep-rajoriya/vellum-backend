import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/database/client.js";
import { accessRepository } from "@/repositories/access.repository.js";
import { invitationRepository } from "@/repositories/invitation.repository.js";
import { hashInviteToken } from "@/services/inviteToken.service.js";
import type { Actor } from "@/types/actor.js";
import { isAppError } from "@/utils/errors.js";

import {
  addCollaborator,
  createDocument,
  createUser,
  migrateTestDatabase,
  resetDatabase,
} from "../helpers/db.js";

/**
 * The invitation flow, tested at the repository boundary.
 *
 * Sharing is not a direct write to `collaborators`: an invitation is created and emailed, and only an
 * *accept* by the addressed email turns it into access. The tests below pin the two properties that
 * make this safe — a leaked link cannot grant a *different* account access (accept requires the
 * signed-in email to match), and inviting is owner-only — plus the lifecycle: revoke, expiry, re-invite.
 */

/** Create a user with a chosen email — the flow's correctness depends on which email accepts. */
async function createUserWithEmail(email: string, name = "User"): Promise<Actor> {
  const user = await prisma.user.create({
    data: { email: email.toLowerCase(), name },
    select: { id: true, email: true },
  });
  return { userId: user.id, email: user.email };
}

const isCode = (code: string) => (error: unknown) => isAppError(error) && error.code === code;

describe("invitations", () => {
  beforeAll(() => {
    migrateTestDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it("an owner invites an email → a PENDING invitation and a link token", async () => {
    const owner = await createUser("Owner");
    const documentId = await createDocument(owner);

    const { invitation, dispatch } = await invitationRepository.create(
      owner,
      documentId,
      "Invitee@Test.local",
      "EDITOR",
    );

    expect(invitation.status).toBe("PENDING");
    expect(invitation.email).toBe("invitee@test.local"); // normalised to lowercase
    expect(invitation.role).toBe("EDITOR");
    expect(dispatch.token).toBeTruthy();

    // What is stored is the HMAC of the token, never the token itself.
    const row = await prisma.invitation.findUnique({
      where: { tokenHash: hashInviteToken(dispatch.token) },
      select: { id: true },
    });
    expect(row?.id).toBe(invitation.id);
  });

  it("an email with no account can be invited — existence is resolved at accept, not invite", async () => {
    const owner = await createUser("Owner");
    const documentId = await createDocument(owner);

    const { invitation } = await invitationRepository.create(
      owner,
      documentId,
      "nobody-here-yet@test.local",
      "VIEWER",
    );

    expect(invitation.status).toBe("PENDING");
  });

  it("accepting with the matching email creates the collaborator with the invited role", async () => {
    const owner = await createUser("Owner");
    const documentId = await createDocument(owner);
    const invitee = await createUserWithEmail("friend@test.local");

    const { dispatch } = await invitationRepository.create(
      owner,
      documentId,
      "friend@test.local",
      "EDITOR",
    );

    const result = await invitationRepository.accept(invitee, dispatch.token);
    expect(result.documentId).toBe(documentId);

    const access = await accessRepository.find(invitee, documentId);
    expect(access?.role).toBe("EDITOR");

    const inv = await prisma.invitation.findFirst({
      where: { documentId, email: "friend@test.local" },
      select: { status: true, acceptedById: true },
    });
    expect(inv?.status).toBe("ACCEPTED");
    expect(inv?.acceptedById).toBe(invitee.userId);
  });

  it("a leaked link cannot grant a DIFFERENT account access", async () => {
    const owner = await createUser("Owner");
    const documentId = await createDocument(owner);
    const wrongAccount = await createUserWithEmail("someone-else@test.local");

    const { dispatch } = await invitationRepository.create(
      owner,
      documentId,
      "intended@test.local",
      "EDITOR",
    );

    await expect(invitationRepository.accept(wrongAccount, dispatch.token)).rejects.toSatisfy(
      isCode("FORBIDDEN"),
    );

    // And the wrong account gained nothing.
    const access = await accessRepository.find(wrongAccount, documentId);
    expect(access).toBeNull();
  });

  it("an accepted VIEWER still cannot write", async () => {
    const owner = await createUser("Owner");
    const documentId = await createDocument(owner);
    const invitee = await createUserWithEmail("reader@test.local");

    const { dispatch } = await invitationRepository.create(
      owner,
      documentId,
      "reader@test.local",
      "VIEWER",
    );
    await invitationRepository.accept(invitee, dispatch.token);

    await expect(accessRepository.authorize(invitee, documentId, "write")).rejects.toSatisfy(
      isCode("FORBIDDEN"),
    );
    await expect(accessRepository.authorize(invitee, documentId, "read")).resolves.toMatchObject({
      role: "VIEWER",
    });
  });

  it("a non-owner cannot invite (manage is owner-only)", async () => {
    const owner = await createUser("Owner");
    const editor = await createUser("Editor");
    const documentId = await createDocument(owner);
    await addCollaborator(documentId, editor, "EDITOR");

    await expect(
      invitationRepository.create(editor, documentId, "x@test.local", "VIEWER"),
    ).rejects.toSatisfy(isCode("FORBIDDEN"));
  });

  it("a revoked invitation's token stops working", async () => {
    const owner = await createUser("Owner");
    const documentId = await createDocument(owner);
    const invitee = await createUserWithEmail("revoked@test.local");

    const { invitation, dispatch } = await invitationRepository.create(
      owner,
      documentId,
      "revoked@test.local",
      "EDITOR",
    );
    await invitationRepository.revoke(owner, documentId, invitation.id);

    await expect(invitationRepository.accept(invitee, dispatch.token)).rejects.toSatisfy(
      isCode("BAD_REQUEST"),
    );
    expect(await accessRepository.find(invitee, documentId)).toBeNull();
  });

  it("an expired invitation cannot be accepted", async () => {
    const owner = await createUser("Owner");
    const documentId = await createDocument(owner);
    const invitee = await createUserWithEmail("expired@test.local");

    const { invitation, dispatch } = await invitationRepository.create(
      owner,
      documentId,
      "expired@test.local",
      "EDITOR",
    );
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    await expect(invitationRepository.accept(invitee, dispatch.token)).rejects.toSatisfy(
      isCode("BAD_REQUEST"),
    );
  });

  it("preview withholds the document title unless the signed-in email matches", async () => {
    const owner = await createUser("Owner");
    const documentId = await createDocument(owner, "Secret Plans");
    const match = await createUserWithEmail("match@test.local");
    const stranger = await createUserWithEmail("stranger@test.local");

    const { dispatch } = await invitationRepository.create(
      owner,
      documentId,
      "match@test.local",
      "EDITOR",
    );

    const asMatch = await invitationRepository.preview(match, dispatch.token);
    expect(asMatch.emailMatches).toBe(true);
    expect(asMatch.documentTitle).toBe("Secret Plans");
    expect(asMatch.role).toBe("EDITOR");

    const asStranger = await invitationRepository.preview(stranger, dispatch.token);
    expect(asStranger.emailMatches).toBe(false);
    expect(asStranger.documentTitle).toBeNull();
    expect(asStranger.invitedEmail).toBe("match@test.local");
  });

  it("you cannot invite yourself or someone who already has access", async () => {
    const owner = await createUser("Owner");
    const documentId = await createDocument(owner);

    await expect(
      invitationRepository.create(owner, documentId, owner.email, "EDITOR"),
    ).rejects.toSatisfy(isCode("BAD_REQUEST"));

    const existing = await createUser("Existing");
    await addCollaborator(documentId, existing, "VIEWER");
    await expect(
      invitationRepository.create(owner, documentId, existing.email, "EDITOR"),
    ).rejects.toSatisfy(isCode("BAD_REQUEST"));
  });

  it("re-inviting refreshes the token (old link dies) and updates the role, on one row", async () => {
    const owner = await createUser("Owner");
    const documentId = await createDocument(owner);
    const invitee = await createUserWithEmail("reinvited@test.local");

    const first = await invitationRepository.create(
      owner,
      documentId,
      "reinvited@test.local",
      "VIEWER",
    );
    const second = await invitationRepository.create(
      owner,
      documentId,
      "reinvited@test.local",
      "EDITOR",
    );

    // Same invitation row (upsert on document+email), so no duplicates pile up.
    expect(second.invitation.id).toBe(first.invitation.id);

    // The old link no longer works…
    await expect(invitationRepository.accept(invitee, first.dispatch.token)).rejects.toThrow();

    // …the new one does, with the updated role.
    await invitationRepository.accept(invitee, second.dispatch.token);
    const access = await accessRepository.find(invitee, documentId);
    expect(access?.role).toBe("EDITOR");
  });

  it("declining marks the invitation DECLINED and grants nothing", async () => {
    const owner = await createUser("Owner");
    const documentId = await createDocument(owner);
    const invitee = await createUserWithEmail("decliner@test.local");

    const { dispatch } = await invitationRepository.create(
      owner,
      documentId,
      "decliner@test.local",
      "EDITOR",
    );
    await invitationRepository.decline(invitee, dispatch.token);

    expect(await accessRepository.find(invitee, documentId)).toBeNull();
    const inv = await prisma.invitation.findFirst({
      where: { documentId, email: "decliner@test.local" },
      select: { status: true },
    });
    expect(inv?.status).toBe("DECLINED");
  });
});
