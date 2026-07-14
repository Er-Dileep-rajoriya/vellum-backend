import type { Server } from "node:http";

import { WebSocketServer, type WebSocket } from "ws";

import {
  WS_HEARTBEAT_INTERVAL_MS,
  WS_MAX_MESSAGES_PER_SECOND,
  WS_MAX_MESSAGE_BYTES,
} from "@/constants/limits.js";
import { accessRepository } from "@/repositories/access.repository.js";
import { setBroadcaster, syncService } from "@/services/sync.service.js";
import { verifyAccessToken } from "@/services/token.service.js";
import type { Actor } from "@/types/actor.js";
import { isAppError } from "@/utils/errors.js";
import { logger } from "@/utils/logger.js";

import { Hub, type Connection } from "./hub.js";
import { ClientMessageSchema, type ServerMessage } from "./protocol.js";

/**
 * The realtime relay.
 *
 * It runs the SAME commit pipeline as the HTTP route — `syncService.push` — which is the single most
 * important property of this file. The socket is a latency optimisation over the sync protocol, never
 * a second protocol (D-006). Concretely, that means:
 *
 *   - a VIEWER cannot write through the socket, because `syncService.push` authorizes;
 *   - a malformed operation is rejected identically, because the same zod schema validates;
 *   - a replayed operation is deduplicated identically, because the same unique constraint applies;
 *   - if the relay is down, the product still works over HTTP — degraded latency, identical correctness.
 *
 * A collaboration server that implements its own write path is a collaboration server with a second,
 * less-tested set of security checks. This one has none of its own.
 */

export function attachWebSocketServer(httpServer: Server): Hub {
  const hub = new Hub();

  // `noServer` + a manual upgrade handler, so authentication happens BEFORE the socket is established.
  // The `ws` library's built-in `verifyClient` runs too late to reject cleanly and cannot be async in
  // a way that composes with our token verification.
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_MESSAGE_BYTES });

  /**
   * The HTTP push path broadcasts through here.
   *
   * Injected rather than imported by the sync service, so the service does not depend on the transport
   * layer — the dependency points inwards. This is also what makes an operation pushed over *HTTP*
   * appear instantly on a collaborator's screen over their *WebSocket*: one pipeline, two transports.
   */
  setBroadcaster((documentId, operations) => {
    hub.broadcastOperations(documentId, operations);
  });

  httpServer.on("upgrade", (request, socket, head) => {
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }

      /**
       * The token arrives as a query parameter, not an Authorization header.
       *
       * Browsers do not permit custom headers on a WebSocket handshake — the API simply has no way to
       * set them. The alternatives are a cookie (which would reintroduce CSRF on a cross-origin socket)
       * or a subprotocol hack. A query parameter is the honest option, and its one real weakness is
       * that URLs get logged: which is exactly why these tokens live 15 minutes and are re-minted from
       * the session rather than being long-lived.
       */
      const token = url.searchParams.get("token");
      const clientId = url.searchParams.get("clientId");

      if (token === null || clientId === null || clientId.length > 64) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      let actor: Actor;
      try {
        actor = await verifyAccessToken(token);
      } catch {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        registerConnection(hub, ws, actor, clientId);
      });
    })();
  });

  /**
   * The heartbeat.
   *
   * A TCP connection can be dead for hours without either side noticing — a laptop lid closes, a phone
   * loses its cell, a NAT silently drops the mapping. The socket stays "open" and the server holds
   * memory and a presence entry for a user who left the building. Ping every 15s; terminate anything
   * that has not ponged within 35s.
   *
   * `terminate()`, not `close()`: a graceful close waits for a response from a peer that, by
   * definition, is not answering.
   */
  const heartbeat = setInterval(() => {
    for (const connection of hub.connections()) {
      if (!connection.alive) {
        logger.debug({ userId: connection.actor.userId }, "terminating unresponsive socket");
        connection.socket.terminate();
        hub.remove(connection);
        continue;
      }

      connection.alive = false;
      try {
        connection.socket.ping();
      } catch {
        hub.remove(connection);
      }
    }
  }, WS_HEARTBEAT_INTERVAL_MS);

  heartbeat.unref();

  wss.on("close", () => clearInterval(heartbeat));

  return hub;
}

function registerConnection(hub: Hub, socket: WebSocket, actor: Actor, clientId: string): void {
  const connection: Connection = {
    socket,
    actor,
    clientId,
    rooms: new Set(),
    presence: new Map(),
    messageTimestamps: [],
    alive: true,
  };

  hub.add(connection);

  socket.on("pong", () => {
    connection.alive = true;
  });

  socket.on("message", (raw: Buffer) => {
    void handleMessage(hub, connection, raw);
  });

  socket.on("close", () => hub.remove(connection));

  socket.on("error", (error) => {
    logger.warn({ err: error, userId: actor.userId }, "websocket error");
    hub.remove(connection);
  });
}

async function handleMessage(hub: Hub, connection: Connection, raw: Buffer): Promise<void> {
  /**
   * Per-socket flood control.
   *
   * A client sending 10,000 messages a second is not a human — a human types at roughly 10 characters
   * per second, and the client batches. It is a bug or an attack, and in both cases the correct
   * response is to disconnect rather than to throttle: throttling keeps the connection (and its
   * memory, and its database load) alive, which is precisely what an attacker wants.
   */
  const now = Date.now();
  connection.messageTimestamps = connection.messageTimestamps.filter((at) => now - at < 1_000);
  connection.messageTimestamps.push(now);

  if (connection.messageTimestamps.length > WS_MAX_MESSAGES_PER_SECOND) {
    logger.warn({ userId: connection.actor.userId }, "websocket flood — disconnecting");
    send(hub, connection, {
      type: "error",
      code: "RATE_LIMITED",
      message: "too many messages",
      retryable: true,
    });
    connection.socket.close(1008, "rate limited");
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    send(hub, connection, {
      type: "error",
      code: "BAD_REQUEST",
      message: "malformed JSON",
      retryable: false,
    });
    return;
  }

  const message = ClientMessageSchema.safeParse(parsed);
  if (!message.success) {
    send(hub, connection, {
      type: "error",
      code: "VALIDATION_FAILED",
      message: "invalid message",
      retryable: false,
    });
    return;
  }

  try {
    switch (message.data.type) {
      case "ping":
        send(hub, connection, { type: "pong" });
        return;

      case "join": {
        const { documentId } = message.data;

        /**
         * Authorization is checked HERE, on join — not once at connection time.
         *
         * A connection is long-lived. A user who is removed from a document mid-session must not keep
         * receiving its operations, and a user who was never a collaborator must not be able to join a
         * room by guessing an id. Re-checking per room is the only version of this that is actually
         * true; checking once at connect would authorize a socket, not an access.
         */
        const access = await accessRepository.authorize(connection.actor, documentId, "read");

        hub.join(connection, documentId);

        const result = await syncService.pull(connection.actor, documentId, 0n, 1);

        send(hub, connection, {
          type: "joined",
          documentId,
          serverSeq: result.documentSeq,
          peers: hub.peers(documentId),
        });

        hub.broadcastPresence(documentId);
        logger.debug({ userId: connection.actor.userId, documentId, role: access.role }, "joined");
        return;
      }

      case "leave":
        hub.leave(connection, message.data.documentId);
        return;

      case "ops": {
        const { documentId, clientId, operations } = message.data;

        // Not in the room → not authorized to write to it. The room membership was established by a
        // `join`, which ran the authorization check. Skipping the join and sending `ops` directly must
        // not work, and it does not: `syncService.push` re-authorizes anyway. This is the cheap check
        // that avoids the database round trip for an obviously-bogus frame.
        if (!connection.rooms.has(documentId)) {
          send(hub, connection, {
            type: "error",
            code: "FORBIDDEN",
            message: "join the document before pushing operations",
            retryable: false,
          });
          return;
        }

        // THE line. The identical pipeline the HTTP route runs: authorize → rate-limit → dedupe →
        // sequence → persist → broadcast. A VIEWER gets a 403 here exactly as they would over HTTP.
        const result = await syncService.push(connection.actor, {
          documentId,
          clientId,
          operations,
        });

        send(hub, connection, {
          type: "ack",
          documentId,
          operationIds: result.acknowledged.map((op) => op.operationId),
          documentSeq: result.documentSeq,
        });

        // `syncService.push` already broadcast to the room via the injected broadcaster — including,
        // harmlessly, back to this author (whose client will dedupe by operationId). The ack above is
        // what the author actually needs: their server sequence numbers.
        return;
      }

      case "presence": {
        const { documentId, blockId, anchor } = message.data;
        if (!connection.rooms.has(documentId)) return;

        connection.presence.set(documentId, { blockId, anchor });
        hub.broadcastPresence(documentId);
        return;
      }
    }
  } catch (error) {
    if (isAppError(error)) {
      send(hub, connection, {
        type: "error",
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      });
      return;
    }

    logger.error({ err: error, userId: connection.actor.userId }, "websocket handler failed");
    send(hub, connection, {
      type: "error",
      code: "INTERNAL",
      message: "internal error",
      retryable: true,
    });
  }
}

function send(hub: Hub, connection: Connection, message: ServerMessage): void {
  hub.send(connection, message);
}
