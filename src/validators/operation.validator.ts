import { z } from "zod";

import {
  MAX_CHAR_IDS_PER_OPERATION,
  MAX_ID_LENGTH,
  MAX_OPERATIONS_PER_BATCH,
  MAX_TEXT_INSERT_LENGTH,
  MAX_TITLE_LENGTH,
} from "@/constants/limits.js";

/**
 * The wire contract for operations.
 *
 * The server does NOT run the CRDT (DECISIONS.md, "server stays a dumb log"): it never folds
 * operations into document state, never merges, never transforms. Its entire job on the write path
 * is to prove an operation is *well-formed and authorised*, give it a place in a total order, and
 * store it.
 *
 * That makes this file the whole of the server's understanding of a document — which is precisely
 * why it must be strict. `.strict()` everywhere: an unknown key is not ignored, it is a rejection.
 * An extra field on an operation means the client and server disagree about the protocol, and the
 * failure mode of "ignore it" is that a future field silently does nothing in production for a
 * month before anyone notices.
 */

/** Ids are opaque to the server, but they are not unbounded strings. */
const Id = z.string().min(1).max(MAX_ID_LENGTH);

/**
 * A ULID: 26 characters, Crockford base32, lexicographically sortable by creation time.
 * Client-generated. This is the idempotency key of the entire system, so its shape is checked
 * rather than trusted — a client that sends a 4KB "operationId" is either broken or probing.
 */
const Ulid = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, { error: "operationId must be a ULID" });

/**
 * A character identity in the sequence CRDT: `<clientId>:<counter>`.
 *
 * Uniqueness is structural, not probabilistic: the clientId namespaces the counter, and a replica
 * never reuses a counter. The server does not interpret these — it only bounds them — but a
 * malformed CharId would corrupt every replica that folds it, so it is validated at the door.
 */
const CharId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,32}:\d{1,12}$/, { error: "malformed CharId" });

/**
 * Fractional index for block ordering (DECISIONS.md D-004). An opaque, lexicographically
 * comparable base62 key. The server never generates or compares these; it stores them.
 */
const FracIndex = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[0-9A-Za-z]+$/, { error: "malformed fractional index" });

export const BlockTypeSchema = z.enum([
  "paragraph",
  "heading1",
  "heading2",
  "heading3",
  "bulletList",
  "numberedList",
  "todo",
  "quote",
  "code",
  "divider",
  "image",
  "table",
  "callout",
]);

export const MarkTypeSchema = z.enum([
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
  "link",
  "mention",
  "highlight",
]);

/**
 * Block attributes are a bag of scalars, merged per-key as LWW-registers (heading level, code
 * language, checked state, image src…). Values are constrained to scalars precisely *because* they
 * are LWW-merged: a nested object under LWW would silently drop a concurrent sibling edit, which
 * is the data-loss class the whole architecture exists to avoid. Anything that needs to merge
 * gets modelled as its own operation type, not smuggled in here as a nested blob.
 */
const AttrValue = z.union([
  z.string().max(2_048),
  // zod 4 rejects Infinity and NaN from z.number() by default; .finite() is now a no-op.
  z.number(),
  z.boolean(),
  z.null(),
]);
const Attrs = z.record(z.string().max(64), AttrValue).refine(
  (attrs) => Object.keys(attrs).length <= 32,
  { error: "too many attributes on one block" },
);

/**
 * A mark's value: `true` for bold/italic, a URL for a link, a userId for a mention. `null` clears
 * the mark — clearing is a *set to null*, not a delete, because a delete has no position in an
 * LWW-register and could not be ordered against a concurrent set.
 */
const MarkValue = z.union([z.boolean(), z.string().max(2_048), z.null()]);

const CharIdList = z
  .array(CharId)
  .min(1)
  .max(MAX_CHAR_IDS_PER_OPERATION);

/**
 * Payloads, discriminated by operationType. Each is `.strict()`.
 */
export const OperationPayloadSchemas = {
  BLOCK_INSERT: z
    .object({
      blockId: Id,
      blockType: BlockTypeSchema,
      fracIndex: FracIndex,
      attrs: Attrs.default({}),
    })
    .strict(),

  BLOCK_REMOVE: z
    .object({
      blockId: Id,
    })
    .strict(),

  BLOCK_MOVE: z
    .object({
      blockId: Id,
      fracIndex: FracIndex,
    })
    .strict(),

  BLOCK_SET_ATTRS: z
    .object({
      blockId: Id,
      /** Partial: only the keys being set. Each key is an independent LWW-register. */
      attrs: Attrs,
      /** Optional type change (paragraph -> heading1 via a markdown shortcut). */
      blockType: BlockTypeSchema.optional(),
    })
    .strict(),

  TEXT_INSERT: z
    .object({
      blockId: Id,
      /** Id of the first character in the run; subsequent characters take consecutive counters. */
      charId: CharId,
      /**
       * The character this run is anchored *after*. `null` means "beginning of block".
       * This is the RGA origin: without it, concurrent inserts have no defined position and the
       * merge is not deterministic. It is required, not optional, for exactly that reason.
       */
      originLeft: CharId.nullable(),
      value: z.string().min(1).max(MAX_TEXT_INSERT_LENGTH),
    })
    .strict(),

  TEXT_DELETE: z
    .object({
      blockId: Id,
      /** Tombstones these characters. Set semantics: applying twice is applying once. */
      charIds: CharIdList,
    })
    .strict(),

  MARK_SET: z
    .object({
      blockId: Id,
      charIds: CharIdList,
      mark: MarkTypeSchema,
      value: MarkValue,
    })
    .strict(),
} as const;

export const OperationTypeSchema = z.enum([
  "BLOCK_INSERT",
  "BLOCK_REMOVE",
  "BLOCK_MOVE",
  "BLOCK_SET_ATTRS",
  "TEXT_INSERT",
  "TEXT_DELETE",
  "MARK_SET",
]);

/**
 * The base envelope, shared by every operation type.
 *
 * `userId` is deliberately absent. The client cannot assert who it is: the server takes the
 * identity from the verified access token and writes that. A `userId` field on the wire would be
 * a field an attacker gets to fill in, and the only way to be sure it is never trusted is for it
 * not to exist. (ARCHITECTURE.md §10, "spoofed identity".)
 */
const OperationEnvelope = {
  operationId: Ulid,
  clientId: Id,
  /** Lamport counter. Merge ordering. Wall-clock time is never used for merge decisions. */
  logicalClock: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  /** Authoring time. UI and audit only. A client with a wrong clock cannot corrupt a merge. */
  timestamp: z.coerce.date(),
  /** The serverSeq this replica had seen when it authored. Used to measure divergence, not to reject. */
  documentVersion: z.coerce.bigint().nonnegative(),
} as const;

/**
 * A discriminated union over operationType, so that TypeScript narrows the payload from the tag
 * and an invalid (type, payload) pairing is a parse error rather than a runtime surprise three
 * layers down.
 */
export const OperationSchema = z.discriminatedUnion("operationType", [
  z.object({ ...OperationEnvelope, operationType: z.literal("BLOCK_INSERT"), payload: OperationPayloadSchemas.BLOCK_INSERT }).strict(),
  z.object({ ...OperationEnvelope, operationType: z.literal("BLOCK_REMOVE"), payload: OperationPayloadSchemas.BLOCK_REMOVE }).strict(),
  z.object({ ...OperationEnvelope, operationType: z.literal("BLOCK_MOVE"), payload: OperationPayloadSchemas.BLOCK_MOVE }).strict(),
  z.object({ ...OperationEnvelope, operationType: z.literal("BLOCK_SET_ATTRS"), payload: OperationPayloadSchemas.BLOCK_SET_ATTRS }).strict(),
  z.object({ ...OperationEnvelope, operationType: z.literal("TEXT_INSERT"), payload: OperationPayloadSchemas.TEXT_INSERT }).strict(),
  z.object({ ...OperationEnvelope, operationType: z.literal("TEXT_DELETE"), payload: OperationPayloadSchemas.TEXT_DELETE }).strict(),
  z.object({ ...OperationEnvelope, operationType: z.literal("MARK_SET"), payload: OperationPayloadSchemas.MARK_SET }).strict(),
]);

export type IncomingOperation = z.infer<typeof OperationSchema>;

/**
 * A push batch.
 *
 * Duplicate operationIds *within* one batch are rejected outright rather than silently deduped.
 * Cross-batch duplicates are normal and expected (a retry after a timeout) and are handled by the
 * database's unique constraint. A duplicate *inside* a single batch, however, cannot be a retry —
 * it is a broken client or a probe, and quietly accepting it would mask a real bug in the sync
 * engine that would otherwise surface immediately in development.
 */
export const PushRequestSchema = z
  .object({
    documentId: Id,
    clientId: Id,
    operations: z
      .array(OperationSchema)
      .min(1)
      .max(MAX_OPERATIONS_PER_BATCH)
      .refine(
        (ops) => new Set(ops.map((op) => op.operationId)).size === ops.length,
        { error: "duplicate operationId within a single batch" },
      )
      .refine(
        (ops) => {
          // `.min(1)` above guarantees a first element, but the compiler cannot see across the
          // refinement chain — and a non-null assertion here would be an unverifiable claim. The
          // explicit check costs nothing and is honest.
          const first = ops[0];
          return first === undefined || ops.every((op) => op.clientId === first.clientId);
        },
        { error: "all operations in a batch must originate from one clientId" },
      ),
  })
  .strict();

export type PushRequest = z.infer<typeof PushRequestSchema>;

export const PullQuerySchema = z
  .object({
    documentId: Id,
    /** Exclusive cursor: return operations with serverSeq strictly greater than this. */
    since: z.coerce.bigint().nonnegative().default(0n),
    limit: z.coerce.number().int().min(1).max(1_000).optional(),
  })
  .strict();

export type PullQuery = z.infer<typeof PullQuerySchema>;

export const DocumentTitleSchema = z.string().trim().min(1).max(MAX_TITLE_LENGTH);
