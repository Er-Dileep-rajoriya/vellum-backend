import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { aiService } from "@/ai/ai.service.js";
import { MAX_AI_CONTEXT_CHARS, MAX_AI_PROMPT_CHARS } from "@/constants/limits.js";
import { actorOf, requireAuth } from "@/middlewares/auth.middleware.js";
import { actorRateLimit } from "@/middlewares/rateLimit.middleware.js";
import { isAppError } from "@/utils/errors.js";

const AiRequestSchema = z
  .object({
    action: z.enum([
      "REWRITE",
      "IMPROVE",
      "SUMMARIZE",
      "TRANSLATE",
      "FIX_GRAMMAR",
      "CHANGE_TONE",
      "MEETING_NOTES",
      "ACTION_ITEMS",
      "CONTINUE_WRITING",
      "EXPLAIN",
      "GENERATE_TITLE",
      "DOCUMENT_INSIGHTS",
    ]),
    documentId: z.string().min(1).max(64),
    // Capped here as well as truncated in the service: the byte cap stops a 900MB body, and this
    // stops a 900KB one that would be legal at the transport layer but is still absurd.
    content: z.string().min(1).max(MAX_AI_CONTEXT_CHARS * 2),
    prompt: z.string().max(MAX_AI_PROMPT_CHARS).optional(),
  })
  .strict();

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", actorRateLimit);

  /**
   * Streaming completion, over Server-Sent Events.
   *
   * SSE rather than a WebSocket: this is a one-way, short-lived, request-scoped stream. A socket
   * would need its own lifecycle, its own reconnect, and its own auth — for a stream that lives
   * fifteen seconds and has exactly one consumer. SSE is the boring, correct answer.
   *
   * The key property is that the client renders tokens as they arrive, so the user sees the AI
   * *writing*. A 12-second wait on a spinner and a 12-second stream of text take exactly the same
   * time and feel nothing alike.
   */
  app.post("/ai/stream", async (request, reply) => {
    const actor = actorOf(request);
    const body = AiRequestSchema.parse(request.body);

    // Set SSE headers on the raw response before writeHead
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    
    // writeHead will send all currently-set headers (including CORS headers from middleware)
    reply.raw.writeHead(200);

    const send = (data: unknown): void => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    /**
     * If the user closes the tab or hits Escape mid-generation, stop generating. Without this we
     * keep pulling tokens from the model — and paying for them — to write them into a socket nobody
     * is reading.
     */
    const aborted = { value: false };
    request.raw.on("close", () => {
      aborted.value = true;
    });

    try {
      for await (const chunk of aiService.stream(actor, body)) {
        if (aborted.value) break;
        send(chunk);
      }
    } catch (error) {
      // The headers are already sent, so the normal error handler cannot set a status code. Report
      // the failure inside the stream instead — the client is listening there.
      const message = isAppError(error) ? error.message : "the AI request failed";
      const code = isAppError(error) ? error.code : "INTERNAL";
      send({ type: "error", message, code });
    } finally {
      reply.raw.end();
    }

    return reply;
  });

  /** The AI usage panel: what was asked, what it cost, and what failed. */
  app.get("/ai/history", async (request, reply) => {
    const actor = actorOf(request);
    const query = z
      .object({ documentId: z.string().min(1).max(64).optional() })
      .parse(request.query);

    const history = await aiService.history(actor, query.documentId);
    return reply.send({ history });
  });
}
