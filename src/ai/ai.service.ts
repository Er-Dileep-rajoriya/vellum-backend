import OpenAI from "openai";

import { env } from "@/config/env.js";
import {
  AI_RATE_LIMIT_WINDOW_MS,
  MAX_AI_CONTEXT_CHARS,
  MAX_AI_OUTPUT_TOKENS,
} from "@/constants/limits.js";
import { prisma } from "@/database/client.js";
import type { AiAction } from "@/generated/prisma/enums.js";
import { accessRepository } from "@/repositories/access.repository.js";
import { rateLimitRepository } from "@/repositories/rateLimit.repository.js";
import type { Actor } from "@/types/actor.js";
import { badRequest, internal, rateLimited } from "@/utils/errors.js";
import { logger } from "@/utils/logger.js";

import { AI_PROMPTS, buildUserMessage } from "./prompts.js";

/**
 * The AI service.
 *
 * The architectural claim (DECISIONS.md D-014) is that AI is not a feature bolted onto the side of
 * the editor — it is an ordinary *operation producer*. The server streams text; the client turns
 * that text into `text.delete` + `text.insert` CRDT operations through the same `OperationFactory`
 * a keystroke goes through.
 *
 * Everything follows from that one decision, for free and with no special-casing:
 *
 *   - an AI edit is **undoable**, because it is operations;
 *   - it works **offline** (queued in the outbox), because it is operations;
 *   - it **merges** with a collaborator typing in the same paragraph, because it is operations;
 *   - it appears in **version history** attributed to the user who invoked it;
 *   - it is **audited**.
 *
 * The alternative — AI writing directly into document state — would need its own merge, its own
 * undo, its own offline story, and it would be the one code path in the system capable of silently
 * destroying a collaborator's concurrent edit.
 */

/**
 * DeepSeek, driven through the OpenAI-compatible client.
 *
 * DeepSeek's HTTP API mirrors OpenAI's `/chat/completions` (including SSE streaming and
 * `stream_options.include_usage` for token accounting), so the official `openai` SDK works unchanged
 * once its `baseURL` is pointed at DeepSeek. Using the SDK rather than hand-rolled `fetch` gives us
 * battle-tested SSE parsing, abort handling, and typed responses for free.
 */
const deepseek =
  env.DEEPSEEK_API_KEY === ""
    ? null
    : new OpenAI({
        apiKey: env.DEEPSEEK_API_KEY,
        baseURL: env.DEEPSEEK_BASE_URL,
      });

export interface AiRequest {
  readonly action: AiAction;
  readonly documentId: string;
  /** The selected text, or the whole document for document-level actions. */
  readonly content: string;
  /** Free-text parameter: the target language, the desired tone, a rewrite instruction. */
  readonly prompt?: string | undefined;
}

export interface AiStreamChunk {
  readonly type: "delta" | "done" | "error";
  readonly text?: string;
  readonly message?: string;
}

export const aiService = {
  /**
   * Stream a completion.
   *
   * An async generator rather than a callback: the route handler pipes it straight into the HTTP
   * response, so back-pressure works — if the client stops reading, the generator stops pulling from
   * the model, and we stop paying for tokens nobody will ever see.
   */
  async *stream(actor: Actor, request: AiRequest): AsyncGenerator<AiStreamChunk> {
    if (deepseek === null) {
      throw internal("AI is not configured on this server");
    }

    // Writes require write access; read-only analysis (summarise, explain) requires only read. A
    // VIEWER may ask the AI to explain a paragraph; they may not ask it to rewrite one, because the
    // rewrite would arrive as operations they are not permitted to author.
    const spec = AI_PROMPTS[request.action];
    await accessRepository.authorize(
      actor,
      request.documentId,
      spec.replacesSelection ? "write" : "read",
    );

    if (request.content.trim() === "") {
      throw badRequest("no text was selected");
    }

    /**
     * The AI budget is its own rate limit, denominated in *calls per hour* rather than requests per
     * minute. Tokens are money in a way that database rows are not: a scripted client could burn a
     * month of API spend in an afternoon while staying comfortably inside the ordinary request
     * limit, because 60 AI calls cost more than 60,000 document reads.
     */
    const verdict = await rateLimitRepository.consume(
      `ai:${actor.userId}`,
      env.RATE_LIMIT_AI_PER_HOUR,
      AI_RATE_LIMIT_WINDOW_MS,
    );
    if (!verdict.allowed) throw rateLimited(verdict.retryAfterSeconds);

    // Truncate the context rather than rejecting it. A user selecting an entire 200-page document
    // should get a summary of the first 40k characters with a warning, not an error telling them
    // their document is too big to use the product on.
    const content = request.content.slice(0, MAX_AI_CONTEXT_CHARS);
    const truncated = request.content.length > MAX_AI_CONTEXT_CHARS;

    const startedAt = Date.now();
    let output = "";
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      // The system prompt and the fenced document travel as two messages: the system role is the
      // operator's voice, the user role carries the document as data. `include_usage` asks DeepSeek to
      // emit a final chunk with token counts, for the cost accounting below.
      const stream = await deepseek.chat.completions.create({
        model: env.DEEPSEEK_MODEL,
        max_tokens: MAX_AI_OUTPUT_TOKENS,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: spec.system },
          { role: "user", content: buildUserMessage(request.action, content, request.prompt) },
        ],
      });

      let finishReason: string | null = null;

      for await (const chunk of stream) {
        // The usage chunk (emitted last, thanks to include_usage) carries no choices — guard for it.
        const choice = chunk.choices[0];
        const delta = choice?.delta?.content ?? "";
        if (delta !== "") {
          output += delta;
          yield { type: "delta", text: delta };
        }
        if (choice?.finish_reason != null) finishReason = choice.finish_reason;
        if (chunk.usage != null) {
          inputTokens = chunk.usage.prompt_tokens;
          outputTokens = chunk.usage.completion_tokens;
        }
      }

      /**
       * The model produced nothing — a content filter, a refusal, or a degenerate empty completion.
       * Surface it as an error rather than a silent empty result, which would look like a bug in the
       * editor rather than a decision by the model. (OpenAI-compatible APIs have no dedicated
       * "refusal" stop reason the way some providers do; an empty body is the signal.)
       */
      if (output.trim() === "") {
        yield {
          type: "error",
          message:
            finishReason === "content_filter"
              ? "The model declined this request."
              : "The model returned no content. Please try again.",
        };
        return;
      }

      yield {
        type: "done",
        ...(truncated
          ? { message: "The selection was long, so only the first part was used." }
          : {}),
      };
    } catch (error) {
      logger.error({ err: error, action: request.action, userId: actor.userId }, "AI call failed");
      yield { type: "error", message: "The AI request failed. Please try again." };
    } finally {
      /**
       * Log every call — including the failures.
       *
       * Three reasons, in ascending order of importance: cost attribution (tokens are money and
       * somebody will eventually ask which team spent it), abuse detection (a user running ten
       * thousand rewrites is either scripting or being farmed), and the in-product usage panel that
       * users actually look at. Logging only the *successes* would make the failure rate invisible,
       * which is exactly the number you want when the model provider is having a bad day.
       */
      void prisma.aiHistory
        .create({
          data: {
            userId: actor.userId,
            documentId: request.documentId,
            action: request.action,
            model: env.DEEPSEEK_MODEL,
            prompt: request.prompt ?? null,
            inputChars: content.length,
            output: output === "" ? null : output.slice(0, 50_000),
            inputTokens,
            outputTokens,
            latencyMs: Date.now() - startedAt,
          },
        })
        .catch((error: unknown) => {
          // Telemetry must never take down the feature it is measuring.
          logger.warn({ err: error }, "failed to record AI history");
        });
    }
  },

  /** The in-app usage panel: what this user has asked the AI to do, and what it cost. */
  async history(actor: Actor, documentId?: string) {
    const rows = await prisma.aiHistory.findMany({
      where: {
        userId: actor.userId,
        ...(documentId !== undefined ? { documentId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        action: true,
        model: true,
        prompt: true,
        inputTokens: true,
        outputTokens: true,
        latencyMs: true,
        error: true,
        createdAt: true,
      },
    });

    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  },
} as const;
