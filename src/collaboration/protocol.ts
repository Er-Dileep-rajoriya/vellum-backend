import { z } from "zod";

import { MAX_OPERATIONS_PER_BATCH } from "@/constants/limits.js";
import { OperationSchema } from "@/validators/operation.validator.js";

/**
 * The WebSocket protocol.
 *
 * Every frame is validated with the SAME zod schemas as the HTTP body. The socket is an accelerator
 * over the sync protocol, not a second protocol (DECISIONS.md D-006) — which means it cannot become a
 * back door around a validation rule that HTTP enforces. A system with two write paths and one
 * validator is a system with one validated write path and one hole.
 */

export const ClientMessageSchema = z.discriminatedUnion("type", [
  /** Join a document room. Authorization is re-checked here, not inherited from the connection. */
  z.object({ type: z.literal("join"), documentId: z.string().min(1).max(64) }).strict(),

  z.object({ type: z.literal("leave"), documentId: z.string().min(1).max(64) }).strict(),

  /** Push operations. Identical shape to the HTTP push body. */
  z
    .object({
      type: z.literal("ops"),
      documentId: z.string().min(1).max(64),
      clientId: z.string().min(1).max(64),
      operations: z.array(OperationSchema).min(1).max(MAX_OPERATIONS_PER_BATCH),
    })
    .strict(),

  /**
   * Presence: where this user's caret is.
   *
   * Deliberately NOT persisted and deliberately not an operation. A cursor position is ephemeral — it
   * has no meaning once the user disconnects, it must never appear in version history, and writing it
   * to Postgres at 30Hz per user would be a self-inflicted denial of service on the database that
   * holds the actual documents.
   */
  z
    .object({
      type: z.literal("presence"),
      documentId: z.string().min(1).max(64),
      blockId: z.string().min(1).max(64).nullable(),
      anchor: z.string().max(64).nullable(),
    })
    .strict(),

  z.object({ type: z.literal("ping") }).strict(),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export interface PresenceState {
  userId: string;
  clientId: string;
  name: string | null;
  color: string;
  blockId: string | null;
  anchor: string | null;
}

export type ServerMessage =
  | { type: "joined"; documentId: string; serverSeq: string; peers: PresenceState[] }
  | { type: "ops"; documentId: string; operations: unknown[] }
  | { type: "ack"; documentId: string; operationIds: string[]; documentSeq: string }
  | { type: "presence"; documentId: string; peers: PresenceState[] }
  | { type: "error"; code: string; message: string; retryable: boolean }
  | { type: "pong" };

/**
 * A stable colour per user, derived from their id.
 *
 * Deterministic rather than random: the same person is the same colour for everyone in the room, and
 * the same colour tomorrow. A random palette assignment means Alice is blue on your screen and green
 * on mine, which makes "the blue cursor" a meaningless thing to say out loud in a meeting.
 */
const PRESENCE_COLORS = [
  "#e5484d",
  "#e5892f",
  "#f5d90a",
  "#46a758",
  "#12a594",
  "#0091ff",
  "#3e63dd",
  "#8e4ec6",
  "#d6409f",
] as const;

export function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  // The modulo keeps the index in range, but `noUncheckedIndexedAccess` cannot know that. The
  // fallback satisfies it honestly — a non-null assertion here would be a claim the compiler is
  // unable to check, and those are exactly the ones that turn out to be wrong.
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length] ?? PRESENCE_COLORS[0];
}
