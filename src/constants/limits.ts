/**
 * Hard limits.
 *
 * Every number here is a defence against a specific attack, and every one of them is enforced
 * in two places: at the edge (bytes, before a parser ever sees them — see middlewares/bodyLimit.ts)
 * and in the schema (semantics, via zod). Defence in depth is not redundancy here: a 900MB body
 * has already exhausted the heap by the time a validator could reject it, so the byte cap must
 * come first, and the semantic cap must still exist because a 900KB body can still contain a
 * pathological 500,000-element array.
 *
 * These are deliberately generous for humans and hostile to scripts. A person typing continuously
 * for a minute produces ~400 operations; the cap is 600/min. A person cannot produce a 32KB
 * single keystroke; a script can.
 */

/** Absolute request body cap, enforced by streaming the body and aborting past this many bytes. */
export const MAX_REQUEST_BYTES = 1_048_576; // 1 MiB

/** A single sync push batch. */
export const MAX_OPERATIONS_PER_BATCH = 500;
export const MAX_BATCH_BYTES = 524_288; // 512 KiB

/** A single operation's serialised payload. Generous: a paste of a full page is ~8KB. */
export const MAX_OPERATION_BYTES = 32_768; // 32 KiB

/** Text inserted by one operation. Paste of a large document is chunked by the client. */
export const MAX_TEXT_INSERT_LENGTH = 16_384;

/** Character ids referenced by a single delete or mark operation. */
export const MAX_CHAR_IDS_PER_OPERATION = 4_096;

/** Document shape. Beyond this a document should be split; the editor warns at 80%. */
export const MAX_BLOCKS_PER_DOCUMENT = 5_000;
export const MAX_CHARS_PER_BLOCK = 100_000;

/** Pull page size. Bounds both server memory and the client's per-frame apply cost. */
export const MAX_PULL_LIMIT = 1_000;
export const DEFAULT_PULL_LIMIT = 500;

/** Snapshot payload cap — a materialised CRDT document. */
export const MAX_SNAPSHOT_BYTES = 4_194_304; // 4 MiB

/**
 * Version labels and document titles. Short caps prevent a "title" that is really a 1MB payload
 * being rendered into every list view in the product.
 */
export const MAX_TITLE_LENGTH = 200;
export const MAX_LABEL_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 1_000;

/** AI. Context is bounded because tokens are money and an unbounded context is an unbounded bill. */
export const MAX_AI_CONTEXT_CHARS = 40_000;
export const MAX_AI_PROMPT_CHARS = 2_000;
export const MAX_AI_OUTPUT_TOKENS = 4_096;

/** Identifier shapes. Rejecting a 10MB "clientId" costs one length check. */
export const MAX_ID_LENGTH = 64;

/** Idempotency records are replayable for 24h; a retry outliving that is a new request. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * Rate limit windows. The op budget is per-user across all their documents: a user with 40 tabs
 * open is still one user, and the abuse we care about is a script, not a power user.
 */
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const AI_RATE_LIMIT_WINDOW_MS = 3_600_000;

/** WebSocket. A socket that exceeds this is disconnected, not throttled — it is not a human. */
export const WS_MAX_MESSAGES_PER_SECOND = 100;
export const WS_MAX_MESSAGE_BYTES = 262_144; // 256 KiB
/**
 * Ping every 15s. A socket that has not ponged by the NEXT sweep is terminated — so a dead peer is
 * detected within 15–30s. (There is deliberately no separate timeout constant: the alive-flag sweep
 * already bounds detection at two intervals, and a second number would be a value nothing reads.)
 */
export const WS_HEARTBEAT_INTERVAL_MS = 15_000;

/** Version snapshots: every N operations or T milliseconds of activity, whichever comes first. */
export const AUTO_VERSION_EVERY_OPERATIONS = 200;
export const AUTO_VERSION_EVERY_MS = 5 * 60 * 1_000;
