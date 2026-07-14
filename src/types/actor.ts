import type { Role } from "@/generated/prisma/enums.js";

/**
 * The authenticated caller.
 *
 * Every repository method takes an `Actor` as its first argument. This is not ceremony: it makes
 * tenant isolation a property of the *type signature* rather than of a developer remembering to
 * write an authorization check. There is deliberately no `documents.findById(id)` in this codebase
 * — only `documents.findForActor(actor, id)` — so "forgot to check permissions" is a compile error
 * rather than a breach. (DECISIONS.md D-011.)
 *
 * An Actor is only ever constructed from a *verified* access token or the service token. It is
 * never built from a request body.
 */
export interface Actor {
  readonly userId: string;
  readonly email: string;
}

/** The caller's relationship to one document. `null` role means: not a collaborator. */
export interface DocumentAccess {
  readonly documentId: string;
  readonly role: Role;
}

/**
 * What an actor is trying to do. Kept as an explicit enum rather than a boolean like `canWrite`
 * because permissions grow: the day someone adds "comment" or "share", a boolean silently maps it
 * onto the wrong capability, while a new member of this union forces every switch to be revisited.
 */
export type DocumentAction =
  | "read"
  | "write" // push operations (edit + sync are the same capability: a sync IS an edit)
  | "restore" // restore a version
  | "manage" // invite/remove collaborators, change roles, rename
  | "delete";

/**
 * The authorization matrix, in one place, as data.
 *
 * A VIEWER cannot edit, sync, restore, or delete — the requirement from the brief, encoded once.
 * Note that "edit" and "sync" are not separable: a sync push *is* an edit, arriving later. Any
 * design that lets a viewer sync is a design that lets a viewer edit while offline and then commit
 * it, which is the same thing with extra steps.
 */
const PERMISSIONS: Record<Role, ReadonlySet<DocumentAction>> = {
  OWNER: new Set<DocumentAction>(["read", "write", "restore", "manage", "delete"]),
  EDITOR: new Set<DocumentAction>(["read", "write", "restore"]),
  VIEWER: new Set<DocumentAction>(["read"]),
};

export function can(role: Role, action: DocumentAction): boolean {
  return PERMISSIONS[role].has(action);
}
