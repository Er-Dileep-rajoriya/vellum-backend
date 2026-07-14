import { prisma } from "@/database/client.js";

export interface RateLimitVerdict {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window rate limiting, in Postgres.
 *
 * Why Postgres and not memory: this service runs as N instances behind a load balancer. An
 * in-process counter limits one instance while the other nine wave the traffic through — it is
 * decorative, and worse, it *looks* like protection. (DECISIONS.md D-012.)
 *
 * Why a fixed window and not a sliding log: a sliding window needs a row per request, and the whole
 * point of the limiter is to be cheaper than the thing it protects. A fixed window allows a burst of
 * up to 2× the limit across a window boundary — a real weakness, and an acceptable one, because the
 * threat being defended against is a script hammering the API for minutes, not a burst lasting a few
 * hundred milliseconds. The op budget (600/min) is ~50× what continuous human typing produces, so
 * the boundary burst is invisible to real users and irrelevant to abusers.
 *
 * The whole check is ONE round trip: an upsert that atomically resets the window if it has expired
 * and increments if it has not. Doing it as SELECT-then-UPDATE would be two round trips *and* a race
 * — two concurrent requests would both read count=99, both write 100, and the 101st request would
 * sail through.
 */
export const rateLimitRepository = {
  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitVerdict> {
    const now = new Date();
    const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);

    // ON CONFLICT ... WHERE makes the reset and the increment a single atomic statement:
    //   - if the stored window is older than the current one, this is a new window → count = 1
    //   - otherwise → count = count + 1
    // RETURNING gives us the post-increment count, so there is no read-back.
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      INSERT INTO rate_limits (key, "windowStart", count)
      VALUES (${key}, ${windowStart}, 1)
      ON CONFLICT (key) DO UPDATE
        SET count = CASE
              WHEN rate_limits."windowStart" < ${windowStart} THEN 1
              ELSE rate_limits.count + 1
            END,
            "windowStart" = ${windowStart}
      RETURNING count
    `;

    const count = rows[0]?.count ?? 1;
    const windowEnd = windowStart.getTime() + windowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil((windowEnd - now.getTime()) / 1_000));

    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds,
    };
  },

  /**
   * Drop windows nobody will ever read again. Called from the scheduler, not from the request path —
   * garbage collection is not the user's problem to pay for.
   */
  async collectGarbage(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const { count } = await prisma.rateLimit.deleteMany({
      where: { windowStart: { lt: cutoff } },
    });
    return count;
  },
} as const;
