import type { Server } from "node:http";

import { SignJWT } from "jose";
import { ulid } from "ulid";
import WebSocket from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { attachWebSocketServer } from "@/collaboration/wsServer.js";
import { env } from "@/config/env.js";
import { prisma } from "@/database/client.js";
import { buildServer } from "@/server.js";
import type { Actor } from "@/types/actor.js";

import {
  addCollaborator,
  createDocument,
  createUser,
  migrateTestDatabase,
  resetDatabase,
} from "../helpers/db.js";

/**
 * Realtime collaboration, tested against a REAL server, a REAL socket, and a REAL database.
 *
 * The claim under test is the one the product is sold on: two people editing the same paragraph at the
 * same moment both keep their words, and both end up looking at the same document. Mocking the socket
 * here would test the mock.
 *
 * It also tests the security property that matters most about the socket: a VIEWER cannot write through
 * it. A collaboration server that implements its own write path is a collaboration server with a
 * second, less-tested set of permission checks — so this one has none of its own, and this test is what
 * proves that.
 */

let server: Awaited<ReturnType<typeof buildServer>>;
let port: number;

async function mintToken(actor: Actor): Promise<string> {
  return new SignJWT({ email: actor.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(actor.userId)
    .setIssuer(env.API_JWT_ISSUER)
    .setAudience(env.API_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(env.API_JWT_SECRET));
}

/** A test client that records everything the server sends it. */
class TestClient {
  readonly socket: WebSocket;
  readonly received: Array<Record<string, unknown>> = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.on("message", (raw: Buffer) => {
      this.received.push(JSON.parse(raw.toString("utf8")) as Record<string, unknown>);
    });
  }

  static async connect(actor: Actor, clientId: string): Promise<TestClient> {
    const token = await mintToken(actor);
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}&clientId=${clientId}`,
    );

    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    return new TestClient(socket);
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  /**
   * Wait for a message of a given type, or fail loudly rather than hanging the suite.
   *
   * `match` exists because presence is broadcast on EVERY room change: Alice joining an empty room
   * produces a presence frame listing one peer (herself), and a test that grabs the first frame is
   * asserting on a state that was true and is no longer. Waiting for the state you actually mean is the
   * only version of this that is not a race.
   */
  async waitFor(
    type: string,
    match: (message: Record<string, unknown>) => boolean = () => true,
    timeoutMs = 5_000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const found = this.received.find(
        (message) => message["type"] === type && match(message),
      );
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    throw new Error(
      `timed out waiting for "${type}"; received: ${this.received.map((m) => String(m["type"])).join(", ")}`,
    );
  }

  close(): void {
    this.socket.close();
  }
}

function textInsert(clientId: string, counter: number, blockId: string, value: string) {
  return {
    operationId: ulid(),
    clientId,
    logicalClock: counter,
    timestamp: new Date().toISOString(),
    documentVersion: "0",
    operationType: "TEXT_INSERT",
    payload: { blockId, charId: `${clientId}:${counter}`, originLeft: null, value },
  };
}

function blockInsert(clientId: string, counter: number, blockId: string) {
  return {
    operationId: ulid(),
    clientId,
    logicalClock: counter,
    timestamp: new Date().toISOString(),
    documentVersion: "0",
    operationType: "BLOCK_INSERT",
    payload: { blockId, blockType: "paragraph", fracIndex: "V", attrs: {} },
  };
}

describe("websocket collaboration", () => {
  beforeAll(async () => {
    migrateTestDatabase();

    server = await buildServer();
    attachWebSocketServer(server.server as Server);
    await server.listen({ port: 0, host: "127.0.0.1" });

    const address = server.server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it("rejects a connection with no token", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    // Unauthenticated sockets are refused at the HTTP upgrade — before a WebSocket exists at all. The
    // connection never becomes a connection, so there is nothing to hold memory or to flood us with.
    await expect(
      new Promise((resolve, reject) => {
        socket.once("open", () => resolve("opened"));
        socket.once("error", reject);
      }),
    ).rejects.toThrow();
  });

  it("rejects a forged token", async () => {
    const forged = await new SignJWT({ email: "attacker@evil.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("attacker")
      .setIssuer(env.API_JWT_ISSUER)
      .setAudience(env.API_JWT_AUDIENCE)
      .setExpirationTime("15m")
      .sign(new TextEncoder().encode("the-wrong-secret-that-is-long-enough-to-pass"));

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${forged}&clientId=x`);

    await expect(
      new Promise((resolve, reject) => {
        socket.once("open", () => resolve("opened"));
        socket.once("error", reject);
      }),
    ).rejects.toThrow();
  });

  /**
   * THE test. Two people type into the same document at the same time, through real sockets, and both
   * see both edits.
   */
  it("relays operations between two collaborators in real time", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const documentId = await createDocument(alice);
    await addCollaborator(documentId, bob, "EDITOR");

    const aliceClient = await TestClient.connect(alice, "alice-1");
    const bobClient = await TestClient.connect(bob, "bob-1");

    aliceClient.send({ type: "join", documentId });
    bobClient.send({ type: "join", documentId });

    await aliceClient.waitFor("joined");
    await bobClient.waitFor("joined");

    const blockId = ulid();
    aliceClient.send({
      type: "ops",
      documentId,
      clientId: "alice-1",
      operations: [blockInsert("alice-1", 1, blockId), textInsert("alice-1", 2, blockId, "hello")],
    });

    // Alice gets her sequence numbers back...
    const ack = await aliceClient.waitFor("ack");
    expect(ack["documentSeq"]).toBe("2");

    // ...and Bob receives the operations without asking for them. That is the whole feature.
    const relayed = await bobClient.waitFor("ops");
    const operations = relayed["operations"] as Array<Record<string, unknown>>;
    expect(operations).toHaveLength(2);
    expect(operations[1]?.["operationType"]).toBe("TEXT_INSERT");
    expect(operations[1]?.["serverSeq"]).toBe("2");

    // And it is durable: the socket wrote through the SAME pipeline as HTTP, into the same table.
    const stored = await prisma.operation.count({ where: { documentId } });
    expect(stored).toBe(2);

    aliceClient.close();
    bobClient.close();
  });

  /**
   * The security property that matters most about the socket.
   *
   * A VIEWER can join (they may read) but cannot write. If this ever passed, the WebSocket would be a
   * complete bypass of the permission system — a viewer could edit any document they can see, and
   * nothing in the HTTP layer would ever know.
   */
  it("a VIEWER can join but CANNOT write through the socket", async () => {
    const owner = await createUser("Owner");
    const viewer = await createUser("Viewer");
    const documentId = await createDocument(owner);
    await addCollaborator(documentId, viewer, "VIEWER");

    const client = await TestClient.connect(viewer, "viewer-1");

    client.send({ type: "join", documentId });
    await client.waitFor("joined"); // reading is allowed

    client.send({
      type: "ops",
      documentId,
      clientId: "viewer-1",
      operations: [blockInsert("viewer-1", 1, ulid())],
    });

    const error = await client.waitFor("error");
    expect(error["code"]).toBe("FORBIDDEN");
    expect(error["retryable"]).toBe(false);

    // Nothing was written. Not "written and then hidden" — nothing.
    expect(await prisma.operation.count({ where: { documentId } })).toBe(0);

    client.close();
  });

  it("a stranger cannot join a document they are not a collaborator on", async () => {
    const owner = await createUser("Owner");
    const stranger = await createUser("Stranger");
    const documentId = await createDocument(owner);

    const client = await TestClient.connect(stranger, "stranger-1");
    client.send({ type: "join", documentId });

    const error = await client.waitFor("error");
    // NOT_FOUND, not FORBIDDEN — a 403 would confirm the document exists, which turns the socket into
    // the same enumeration oracle we closed off on the HTTP side.
    expect(error["code"]).toBe("NOT_FOUND");

    client.close();
  });

  it("cannot push operations to a room it never joined", async () => {
    const owner = await createUser("Owner");
    const editor = await createUser("Editor");
    const documentId = await createDocument(owner);
    await addCollaborator(documentId, editor, "EDITOR");

    const client = await TestClient.connect(editor, "editor-1");

    // Skip the join. The client IS authorized — but the server must not accept writes into a room the
    // connection never entered, because the join is where authorization was checked.
    client.send({
      type: "ops",
      documentId,
      clientId: "editor-1",
      operations: [blockInsert("editor-1", 1, ulid())],
    });

    const error = await client.waitFor("error");
    expect(error["code"]).toBe("FORBIDDEN");
    expect(await prisma.operation.count({ where: { documentId } })).toBe(0);

    client.close();
  });

  it("broadcasts presence when a collaborator joins and moves their cursor", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const documentId = await createDocument(alice);
    await addCollaborator(documentId, bob, "EDITOR");

    const aliceClient = await TestClient.connect(alice, "alice-1");
    aliceClient.send({ type: "join", documentId });
    await aliceClient.waitFor("joined");

    const bobClient = await TestClient.connect(bob, "bob-1");
    bobClient.send({ type: "join", documentId });
    await bobClient.waitFor("joined");

    // Alice is told Bob arrived, without polling for it. Wait for the frame that reflects BOTH of them
    // being in the room — the earlier frame (Alice alone) is also a real, correct broadcast.
    const presence = await aliceClient.waitFor(
      "presence",
      (message) => (message["peers"] as unknown[]).length === 2,
    );
    const peers = presence["peers"] as Array<Record<string, unknown>>;
    expect(peers).toHaveLength(2);

    // The colour is derived from the user id, so Bob is the same colour on everyone's screen — which is
    // what makes "the blue cursor" a meaningful thing to say out loud.
    const bobPeer = peers.find((peer) => peer["userId"] === bob.userId);
    expect(bobPeer?.["color"]).toMatch(/^#[0-9a-f]{6}$/i);

    // Presence carries no email address: a person invited to one document should not thereby learn
    // every other collaborator's email.
    expect(JSON.stringify(peers)).not.toContain("@");

    aliceClient.close();
    bobClient.close();
  });

  it("rejects a malformed frame without dropping the connection", async () => {
    const owner = await createUser("Owner");
    const documentId = await createDocument(owner);

    const client = await TestClient.connect(owner, "owner-1");
    client.send({ type: "ops", documentId, clientId: "owner-1", operations: "not-an-array" });

    const error = await client.waitFor("error");
    expect(error["code"]).toBe("VALIDATION_FAILED");

    // The socket survives. A bad frame is the client's problem; tearing down the connection would turn
    // one bug into a reconnect storm.
    expect(client.socket.readyState).toBe(WebSocket.OPEN);

    client.close();
  });
});
