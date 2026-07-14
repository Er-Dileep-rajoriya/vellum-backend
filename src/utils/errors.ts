/**
 * The error taxonomy.
 *
 * Two properties matter more than the class hierarchy:
 *
 *  1. **Every error knows whether it is the client's fault or ours**, because that single bit
 *     decides what the client's sync engine does with it. A retryable error goes back on the retry
 *     queue with exponential backoff; a non-retryable one goes to the dead-letter queue and is
 *     shown to the user. Getting this bit wrong means either a client that retries a malformed
 *     operation forever (a self-inflicted DoS) or one that silently discards a user's writes
 *     because of a transient 503. Both are worse than the original error.
 *
 *  2. **Nothing leaks.** A 500 says "internal error" and carries a correlation id; the stack, the
 *     SQL, and the row contents go to the log. The most common information disclosure I have seen
 *     in production is not a clever exploit — it is a database error string rendered into an API
 *     response.
 */

export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_FAILED"
  | "PAYLOAD_TOO_LARGE"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "IDEMPOTENCY_MISMATCH"
  | "GONE"
  | "RATE_LIMITED"
  | "INTERNAL";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  PAYLOAD_TOO_LARGE: 413,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_MISMATCH: 422,
  GONE: 410,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

/**
 * Retryability is a property of the error, not a guess made at the call site.
 *
 * Retryable: the request might succeed later without the client changing anything.
 * Not retryable: the request will fail identically forever, so retrying is pure waste and the
 * operation belongs in the dead-letter queue where a human can see it.
 */
const RETRYABLE_BY_CODE: Record<ErrorCode, boolean> = {
  BAD_REQUEST: false,
  VALIDATION_FAILED: false,
  PAYLOAD_TOO_LARGE: false,
  UNAUTHENTICATED: false, // the client must refresh its token, not retry blindly
  FORBIDDEN: false,
  NOT_FOUND: false,
  CONFLICT: true, // e.g. lost an advisory-lock race: the identical retry succeeds
  IDEMPOTENCY_MISMATCH: false,
  GONE: false, // the client must resync from a snapshot; retrying the pull is pointless
  RATE_LIMITED: true, // this is what backoff is *for*
  INTERNAL: true,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  /** Safe to serialise to the client. Never contains SQL, stack traces, or row contents. */
  readonly details: Record<string, unknown> | undefined;
  /** Seconds. Only set on RATE_LIMITED, where the client can do better than blind backoff. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { details?: Record<string, unknown>; retryAfterSeconds?: number; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.retryable = RETRYABLE_BY_CODE[code];
    this.details = options?.details;
    this.retryAfterSeconds = options?.retryAfterSeconds;
    // V8-only API. TypeScript's lib types declare it as always present, so the linter calls this
    // optional chain unnecessary — but it is not: on a non-V8 runtime (Bun's JSC, a browser) the
    // property is undefined and the unguarded call throws inside a constructor for an *error*.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    Error.captureStackTrace?.(this, AppError);
  }

  toJSON(): {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError("BAD_REQUEST", message, details !== undefined ? { details } : undefined);

export const unauthenticated = (message = "authentication required"): AppError =>
  new AppError("UNAUTHENTICATED", message);

/**
 * Deliberately paired with `notFound` in the authorization layer.
 *
 * `forbidden` is only correct when the caller is *already known to be able to see* the resource —
 * a VIEWER attempting to edit a document they can read. When the caller has no relationship to the
 * resource at all, the answer must be `notFound`: a 403 confirms the document exists, which turns
 * id enumeration into a document-discovery oracle for private documents. See ARCHITECTURE.md §10.
 */
export const forbidden = (message = "insufficient permissions"): AppError =>
  new AppError("FORBIDDEN", message);

export const notFound = (resource = "resource"): AppError =>
  new AppError("NOT_FOUND", `${resource} not found`);

export const conflict = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError("CONFLICT", message, details !== undefined ? { details } : undefined);

export const payloadTooLarge = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError("PAYLOAD_TOO_LARGE", message, details !== undefined ? { details } : undefined);

export const rateLimited = (retryAfterSeconds: number): AppError =>
  new AppError("RATE_LIMITED", "rate limit exceeded", { retryAfterSeconds });

/**
 * The client's pull cursor is below the compaction watermark: the operations it is asking for are
 * no longer shipped (ARCHITECTURE.md §8). This is not an error the client can retry its way out
 * of — it must bootstrap from a snapshot and replay its unsynced operations on top. Because those
 * operations are CRDT operations, nothing the user wrote while behind is lost by doing so.
 */
export const gone = (snapshotSeq: bigint): AppError =>
  new AppError("GONE", "cursor is below the compaction watermark; resync from snapshot required", {
    details: { snapshotSeq: snapshotSeq.toString() },
  });

export const internal = (message = "internal error", cause?: unknown): AppError =>
  new AppError("INTERNAL", message, cause !== undefined ? { cause } : undefined);

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
