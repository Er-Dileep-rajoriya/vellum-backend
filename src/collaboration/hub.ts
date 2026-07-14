import type { WebSocket } from "ws";

import type { CommittedOperation } from "@/repositories/operation.repository.js";
import type { Actor } from "@/types/actor.js";
import { logger } from "@/utils/logger.js";

import { colorForUser, type PresenceState, type ServerMessage } from "./protocol.js";

/**
 * The room hub: who is connected, to which document, and how to reach them.
 *
 * Deliberately in-memory and deliberately NOT the source of truth for anything. If this process dies,
 * nothing is lost — presence is ephemeral by definition, and every operation it was about to broadcast
 * is already durable in Postgres. A client that misses a broadcast pulls it on its next cursor poll,
 * because the socket is an optimisation and the log is the truth (D-006).
 *
 * That property is what lets this be a plain Map instead of a distributed system.
 */

export interface Connection {
  readonly socket: WebSocket;
  readonly actor: Actor;
  readonly clientId: string;
  /** Documents this connection has joined. A user may have several open. */
  readonly rooms: Set<string>;
  presence: Map<string, { blockId: string | null; anchor: string | null }>;
  /** Sliding window for the per-socket message budget. */
  messageTimestamps: number[];
  alive: boolean;
}

export class Hub {
  readonly #rooms = new Map<string, Set<Connection>>();
  readonly #connections = new Set<Connection>();

  get connectionCount(): number {
    return this.#connections.size;
  }

  add(connection: Connection): void {
    this.#connections.add(connection);
  }

  remove(connection: Connection): void {
    for (const documentId of connection.rooms) {
      this.leave(connection, documentId);
    }
    this.#connections.delete(connection);
  }

  join(connection: Connection, documentId: string): void {
    connection.rooms.add(documentId);

    const room = this.#rooms.get(documentId);
    if (room === undefined) {
      this.#rooms.set(documentId, new Set([connection]));
    } else {
      room.add(connection);
    }
  }

  leave(connection: Connection, documentId: string): void {
    connection.rooms.delete(documentId);
    connection.presence.delete(documentId);

    const room = this.#rooms.get(documentId);
    if (room === undefined) return;

    room.delete(connection);
    // Drop empty rooms. A long-lived process serving thousands of documents would otherwise
    // accumulate an empty Set per document ever opened — a slow, invisible leak that only shows up as
    // a memory graph creeping up over weeks.
    if (room.size === 0) this.#rooms.delete(documentId);

    this.broadcastPresence(documentId);
  }

  /**
   * Send committed operations to everyone in the room EXCEPT the author.
   *
   * The author already applied them locally — that is the entire point of local-first — and echoing
   * them back would be pure waste. It would also be *harmless*, because operations are idempotent and
   * the client would dedupe them. Both facts are worth stating: the optimisation is safe precisely
   * because the correctness does not depend on it.
   */
  broadcastOperations(
    documentId: string,
    operations: readonly CommittedOperation[],
    exclude?: Connection,
  ): void {
    const room = this.#rooms.get(documentId);
    if (room === undefined || operations.length === 0) return;

    const message: ServerMessage = {
      type: "ops",
      documentId,
      operations: operations as unknown[],
    };
    const payload = JSON.stringify(message);

    for (const connection of room) {
      if (connection === exclude) continue;
      this.#send(connection, payload);
    }
  }

  broadcastPresence(documentId: string): void {
    const room = this.#rooms.get(documentId);
    if (room === undefined) return;

    const peers = this.#peersOf(documentId, room);
    const payload = JSON.stringify({
      type: "presence",
      documentId,
      peers,
    } satisfies ServerMessage);

    for (const connection of room) {
      this.#send(connection, payload);
    }
  }

  peers(documentId: string): PresenceState[] {
    const room = this.#rooms.get(documentId);
    if (room === undefined) return [];
    return this.#peersOf(documentId, room);
  }

  send(connection: Connection, message: ServerMessage): void {
    this.#send(connection, JSON.stringify(message));
  }

  #peersOf(documentId: string, room: ReadonlySet<Connection>): PresenceState[] {
    return [...room].map((connection) => {
      const cursor = connection.presence.get(documentId);
      return {
        userId: connection.actor.userId,
        clientId: connection.clientId,
        // The email local-part, not the full address. A presence list is visible to everyone in the
        // room, including people who were invited to one document and should not thereby learn every
        // collaborator's email address.
        name: connection.actor.email.split("@")[0] ?? null,
        color: colorForUser(connection.actor.userId),
        blockId: cursor?.blockId ?? null,
        anchor: cursor?.anchor ?? null,
      };
    });
  }

  #send(connection: Connection, payload: string): void {
    // readyState 1 === OPEN. A socket that is closing throws on send, and an exception here would take
    // down the broadcast for everyone else in the room — one dead client killing the session for the
    // whole team.
    if (connection.socket.readyState !== 1) return;

    try {
      connection.socket.send(payload);
    } catch (error) {
      logger.warn({ err: error, userId: connection.actor.userId }, "failed to send on websocket");
    }
  }

  /** Every connection, for the heartbeat sweep. */
  connections(): Iterable<Connection> {
    return this.#connections;
  }
}
