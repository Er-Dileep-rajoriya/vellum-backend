# Architecture — Local-First Collaborative Document Editor

> Codename: **Vellum**. A local-first, offline-capable, realtime-collaborative block editor.
> This document is the source of truth for system design. It is written before implementation
> and updated when reality disagrees with it.

---

## 1. Problem statement and engineering challenges

The product requirement is simple to state and hard to build:

> A user opens a document, types immediately (no spinner, no network), keeps typing on a plane,
> lands, and their edits merge with three colleagues' concurrent edits **without losing a single
> keystroke and without any client ending in a different state than any other client.**

That sentence contains every hard problem in the system:

| # | Challenge | Why it is hard | Where it is solved |
|---|---|---|---|
| C1 | **Zero-latency editing** | Any await on the network path before rendering a keystroke is a bug. The UI must never block on IndexedDB either — IDB writes are async and slow (~1–15ms) relative to a 16ms frame. | In-memory CRDT is the render source; IndexedDB is a write-behind append log. §4 |
| C2 | **Convergence** | Concurrent edits must produce byte-identical state on every replica, in any delivery order, with duplicates. Requires operations that are **commutative, associative, idempotent**. LWW is explicitly forbidden (it destroys data). | Custom op-based CRDT. §6 |
| C3 | **Causal readiness** | An insert references its left neighbour. If that neighbour's op hasn't arrived, the op cannot be applied yet — but it also must not be dropped. | Pending-op buffer keyed on missing dependency. §6.6 |
| C4 | **Interleaving** | Naive sequence CRDTs interleave two users' concurrent sentences into word salad. | RGA with origin-anchored, monotone-descending tiebreak. §6.3 |
| C5 | **Unbounded growth** | An append-only oplog grows forever; tombstones never die; a 40-page doc becomes 200MB of history. | Snapshot + watermark compaction. §8 |
| C6 | **Offline durability** | Browser can be killed mid-write. The queue must survive, never double-apply, and never lose an op. | Append-only log + idempotent server + monotonic checkpoints. §7 |
| C7 | **Multi-tab** | Two tabs of the same doc are two replicas on one device. They must not both sync (duplicate work, wasted quota) and must see each other instantly. | Web Locks (sync lock) + BroadcastChannel (fanout). §7.6 |
| C8 | **Adversarial clients** | Everything the client sends is a lie until proven otherwise: 900MB payloads, replayed ops, spoofed `userId`, ops for documents the user cannot read. | Server-side Zod + authz on every op + size caps + idempotency. §10 |
| C9 | **Immutable history + restore** | "Restore v3" cannot rewrite history, and must itself converge across replicas that are concurrently editing. | Restore = forward diff emitted as new ops. §9 |
| C10 | **WebSockets on Vercel** | Vercel serverless functions cannot hold a long-lived socket. | Split deploy: Next on Vercel, WS relay on Fly/Railway. §3 |

**Non-goals (stated explicitly so they are not accidental failures):** rich-text OT-style collaborative
undo across users (undo is local-origin only), operational transformation (rejected, see DECISIONS.md D-002),
peer-to-peer sync without a server, and end-to-end encryption (incompatible with server-side AI).

---

## 2. System shape

```
┌──────────────────────────────────────── Browser (replica) ─────────────────────────────────────────┐
│                                                                                                    │
│  React 19 UI ──renders── DocumentStore (in-memory CRDT)  ◄── the ONLY thing the editor reads       │
│       │                          ▲            │                                                    │
│   beforeinput                    │            │ apply(op)                                          │
│       ▼                          │            ▼                                                    │
│  OpFactory ──op──► LocalApply ───┘      OutboxWriter ──► Dexie (IndexedDB)                         │
│                                                            ├── operations  (append-only log)       │
│                                                            ├── outbox      (unsent op ids)         │
│                                                            ├── snapshots   (materialised doc)      │
│                                                            └── checkpoints (per-doc serverSeq)     │
│                                                                     │                              │
│                                          SyncEngine (scheduler, backoff, DLQ, locks) ◄─────────────┤
│                                                 │                    ▲                             │
└─────────────────────────────────────────────────┼────────────────────┼─────────────────────────────┘
                                     HTTPS push/pull (truth)   WSS live ops (accelerator)
                                                  │                    │
┌──────────────── Next.js 16 (Vercel) ────────────▼────┐   ┌───────▼───── WS Relay (EC2 · pm2) ───────┐
│  Route handlers: /api/sync/push, /api/sync/pull      │   │  authz on connect (JWT), room per doc     │
│  Auth.js, AI streaming, versions, documents          │   │  ingest → validate → commit → broadcast   │
│  Server Components + Suspense for shell              │   │  presence (ephemeral, never persisted)    │
└───────────────────────┬──────────────────────────────┘   └───────────────┬───────────────────────────┘
                        │                                                  │
                        └──────────────► PostgreSQL (Prisma) ◄─────────────┘
                                 operations (unique opId, gapless serverSeq per doc)
                                 versions (immutable snapshots) · audit_logs · ai_history
```

**Both write paths run the identical commit pipeline** (`backend/src/services/sync.service.ts`):
`validate → authorize → dedupe → assign serverSeq → persist → broadcast`.
The WS relay is a *latency optimisation over the same protocol*, never a second protocol.
If the socket dies, everything still works over HTTP polling — degraded latency, identical correctness.

---

## 3. Repository layout — two independent repos

`frontend/` and `backend/` are **standalone repositories**. No monorepo, no workspace, no shared
package. That is a hard constraint, and it forces one question: the CRDT must produce identical
results everywhere it runs, so how is it shared?

**It isn't — because the server never runs it.**

The backend is a *dumb ordered log* (D-005). On the write path it validates op shape, authorizes,
deduplicates, assigns a gapless `serverSeq`, persists, and broadcasts. It never folds operations
into document state, never merges, never transforms. The merge engine therefore has exactly one
implementation, in the client, and there is no second copy to drift.

What the backend does duplicate is ~100 lines of **zod op schemas** — the wire contract. That is a
deliberate, cheap duplication of a *contract*, not of an *algorithm*: if the two drift, requests
fail loudly at the door with a 422, rather than converging to silently different document states.

The one thing this costs: the server cannot independently verify that an uploaded version snapshot
is a faithful fold of the oplog. Snapshots are treated as a **cache, not a source of truth** — the
operation log is authoritative, and any client can rebuild and check a snapshot by replaying it.

```
backend/                        frontend/
├── src/                        ├── app/                  # Next 16 routes (RSC)
│   ├── config/                 ├── components/           # shadcn UI
│   ├── routes/                 ├── editor/               # beforeinput → ops, slash menu, selection
│   ├── controllers/            ├── crdt/                 # ★ RGA, marks, block order — the ONLY copy
│   ├── services/               ├── sync-engine/          # queues, backoff, scheduler, locks, DLQ
│   ├── repositories/           # every method takes (actor, …)
│   ├── database/               ├── collaboration/        # ws client, presence, cursors
│   ├── middlewares/            ├── database/             # dexie schema + local repositories
│   ├── collaboration/  # WS    ├── services/  hooks/  workers/  validators/
│   ├── ai/                     ├── versioning/           # diff, timeline, restore
│   ├── validators/     # zod op schemas (the wire contract)
│   ├── types/  utils/  constants/
├── prisma/                     └── tests/  e2e/
└── tests/
```

Layering rule, enforced by ESLint `import/no-restricted-paths` in both repos:

```
routes → controllers → services → repositories → database
UI/hooks → services → repositories → database(dexie) → crdt
```
UI never imports a repository. A repository never imports React. The CRDT imports nothing at all.

### 3.1 Auth across the repo boundary

Auth.js runs in the frontend and owns the **session**. The backend is a separate origin and cannot
read that cookie, so:

1. Auth.js establishes the session (Google or credentials).
2. The frontend mints a short-lived **HS256 access token** (15 min) signed with a secret both
   services share, and hands it to the browser in memory (never localStorage — an XSS that can read
   localStorage owns the account; a token in a closure dies with the tab).
3. Every backend REST call and the WebSocket handshake carry that token. The backend verifies it
   with `jose` and builds the `Actor` from the **verified claims only**.
4. The session cookie is the refresh mechanism: expiry → silently re-mint.

The frontend has **no database access whatsoever**. User records are created and looked up through
the backend's service-token endpoints, called from Auth.js callbacks. Postgres therefore sits behind
exactly one process, which is what makes tenant isolation auditable rather than aspirational.

---

## 4. Local-first data path (C1)

Three tiers, in order of latency:

1. **In-memory `DocumentStore`** — the CRDT graph plus a materialised view. Reads are O(1) map lookups.
   The editor renders from this and *only* this. Keystroke → op → local apply → React state → paint.
   No `await` anywhere on this path. Target: < 1ms.
2. **IndexedDB (Dexie)** — durability. Ops are appended in a **write-behind** batch flushed on
   `requestIdleCallback` or every 250ms, whichever is first, plus a forced synchronous-ish flush on
   `visibilitychange`/`pagehide`. Losing the last 250ms of typing on a hard kill is acceptable;
   blocking a keystroke on IDB is not.
3. **Server** — eventual. The user never waits for it, and the UI never shows a save spinner,
   only a *sync* status chip.

Reload path: hydrate from Dexie `snapshots` (materialised doc at checkpoint) + replay `operations`
after that checkpoint. Replaying 200k ops on open would be slow, hence snapshots (§8).

---

## 5. The operation

Every mutation in the system — human, AI, or restore — is one of these. Nothing else writes state.

```ts
interface Operation<T extends OpType = OpType> {
  operationId: string;      // ULID. globally unique. the idempotency key.
  documentId: string;
  userId: string;           // asserted by client, OVERWRITTEN by server from session. never trusted.
  clientId: string;         // per-device-per-tab replica id (persisted in IDB)
  logicalClock: number;     // Lamport counter — total causal-ish order + tiebreaks
  timestamp: number;        // wall clock. UI/audit only. NEVER used for merge (clocks lie).
  documentVersion: number;  // last serverSeq the client had seen. used for conflict detection & auditing.
  operationType: T;
  payload: OpPayload[T];    // discriminated union, zod-validated
}
```

`serverSeq` (bigint, gapless per document) is assigned **by the server on commit** and is not part of the
client-authored op. It is the pull cursor — the only thing a client needs to resume from anywhere.

Op types:

| Type | Payload | Semantics |
|---|---|---|
| `block.insert` | `{ blockId, blockType, fracIndex, attrs }` | insert block into ordered list |
| `block.remove` | `{ blockId }` | tombstone block |
| `block.move` | `{ blockId, fracIndex }` | reposition (LWW-register on fracIndex, HLC tiebreak) |
| `block.setAttrs` | `{ blockId, attrs }` | per-key LWW-register (heading level, checked, lang, src…) |
| `text.insert` | `{ blockId, charId, originLeft, value }` | RGA insert of a run of chars |
| `text.delete` | `{ blockId, charIds[] }` | tombstone chars (commutative, idempotent) |
| `mark.set` | `{ blockId, charIds[], mark, value }` | per-(char,markType) LWW-register |

Deliberately **not** an op: "set document content". A whole-doc set is LWW wearing a costume.

---

## 6. Conflict resolution — the merge algorithm (C2, C4)

Design constraint from the brief: *deterministic, never overwrite user changes, not last-write-wins,
operation-based, all replicas identical.* That rules out LWW-on-text and rules out server-authoritative
OT (see DECISIONS.md D-002 for the comparison). What we implement is a **hand-rolled op-based CRDT**
with three different merge strategies, each chosen for the shape of the data it protects.

### 6.1 The three registers

| Data | Strategy | Rationale |
|---|---|---|
| Characters in a block | **RGA** (Replicated Growable Array) with tombstones | Insertions are *additive* — concurrent inserts must both survive. Only a sequence CRDT gives that. |
| Block order | **Fractional index + total order tiebreak** | Blocks are coarse and rarely concurrently reordered; interleaving is not a hazard at block granularity. Fractional indices are O(1), compact, and Figma/Linear-proven. |
| Attributes & marks | **LWW-register per key, HLC-ordered** | For a *scalar* (heading level = 2 vs 3) there is no "merge" — one must win. Losing a value here loses nothing a user typed. LWW is only forbidden where it would destroy authored content; on a scalar key it is the correct answer. |

This split is the core insight: **use the weakest primitive that cannot lose data for the data it guards.**
Applying RGA to a boolean is waste; applying LWW to prose is data loss.

### 6.2 Character identity

`CharId = ${clientId}:${counter}` — dense, unique, never reused. A character is:

```ts
interface Char { id: CharId; value: string; originLeft: CharId | null; deleted: boolean;
                 marks: Record<MarkType, { value: MarkValue; hlc: Hlc }>; }
```

`deleted` is a tombstone: delete is *idempotent* (`deleted = true` twice = once) and *commutative*
with a concurrent insert that anchors to it (the insert still finds its origin). Hard-deleting the
node would break origin resolution and violate convergence. This is why tombstones are non-negotiable
and why §8 exists to eventually bound them.

### 6.3 Insertion rule (the whole ballgame)

When inserting char `c` with `originLeft = L`, walk right from `L` and skip over any char `x` that
was concurrently inserted at the same origin, **while** `x` sorts higher than `c`:

```
insertAfter(L, c):
  i = index(L) + 1
  scan from i:
    x = chars[i]
    if x.originLeft is causally before L  -> stop (x belongs to an earlier region; c goes here)
    if compare(x.id, c.id) > 0            -> i++  (x wins the tie, c goes after it)
    else                                  -> stop
  splice c at i
```

`compare` is a **total order** on CharId: `(counter DESC, clientId DESC)` — lexicographic, deterministic,
and independent of arrival order. Total order + a fixed scan rule ⇒ every replica splices at the same
index ⇒ convergence, proven by induction on op count.

Why this specific tiebreak: descending counter means a user's *own* run of characters (monotonically
increasing counters) stays contiguous instead of being shredded between a concurrent user's characters.
This is the anti-interleaving property (C4) — Alice typing "hello" and Bob typing "world" at the same
caret yields `helloworld` or `worldhello`, deterministically, but never `hweolrllod`.

### 6.4 Deletion
Tombstone only. `text.delete` is a set-union of ids ⇒ commutative + idempotent + order-independent.
A delete arriving *before* the insert it deletes is buffered (§6.6), never dropped.

### 6.5 Marks
Per `(charId, markType)` LWW-register keyed by HLC. Concurrent `bold=true` / `bold=false` on the same
char resolves to the higher HLC, tie broken by clientId. No range anchoring, no split/merge of mark
ranges on concurrent edits — the classic ProseMirror/Yjs mark-anchoring bug class simply does not exist,
at the cost of storing marks per character (sparse map; only set when non-default).

### 6.6 Causal readiness — the pending buffer (C3)
An op whose dependency is missing (`text.insert` whose `originLeft` we've never seen; any op on an
unknown `blockId`) is **not applied and not dropped**. It goes into `PendingBuffer`, indexed by the
missing dependency id. When that dependency lands, dependents are drained recursively. Ops are
therefore delivery-order-independent, which is what lets the WS path and the HTTP-pull path race each
other harmlessly.

Bounded: buffer caps at 10k ops / 5MB per doc; overflow triggers a **full resync** (drop local
uncommitted-nothing, refetch snapshot + tail) rather than unbounded memory growth (C5/OOM).

### 6.7 Idempotence
`operationId` is a ULID with a `UNIQUE` constraint in Postgres and a `Set` in memory. Applying the same
op twice is a no-op at every layer. This is what makes retries, at-least-once delivery, duplicate WS
frames, and replayed batches all safe by construction rather than by luck.

### 6.8 Convergence invariants (asserted in tests, and in dev builds at runtime)
1. `apply(apply(s, a), b) == apply(apply(s, b), a)` for all concurrent a, b — commutativity.
2. `apply(apply(s, a), a) == apply(s, a)` — idempotence.
3. Two replicas with the same op *set* (any order, any duplicates) produce identical `serialize()` output.
   Verified by a **fuzz/property test**: N random replicas × M random ops × random delivery permutations,
   assert byte-equal serialisation. This test is the actual proof; the prose above is just the argument.

---

## 7. Sync engine (C6, C7)

A state machine, not a pile of `setTimeout`s.

```
        ┌──────► IDLE ◄─────────────────────────────┐
        │          │ outbox non-empty & online       │
        │          ▼                                 │
        │      ACQUIRING_LOCK ──(held by other tab)──┘
        │          │
        │          ▼
        │       PUSHING ──ack──► PULLING ──► CHECKPOINT ──► IDLE
        │          │                 │
        │      5xx/network       409 conflict
        │          ▼                 ▼
        └──────  BACKOFF        CONFLICT_QUEUE ──(rebase: ops are CRDT, so just re-apply)──► PUSHING
                   │
              maxRetries (8)
                   ▼
             DEAD_LETTER  ── user-visible, exportable, manually retryable
```

- **Change queue** = Dexie `outbox` (op ids, FIFO by local seq). Survives reload.
- **Batching**: up to 500 ops or 512KB per request, whichever first. Debounced 400ms while typing
  (coalesce a burst of keystrokes into one round-trip) but flushed immediately on idle/blur/online.
- **Backoff**: exponential with full jitter — `min(30s, 500ms × 2^attempt) × rand(0.5..1)`. Jitter is
  not cosmetic: without it, 10k clients reconnecting after an outage self-DDoS the server in lockstep.
- **Retry queue vs failed queue vs DLQ**: retryable (network, 429, 5xx) → retry with backoff.
  Non-retryable (400 malformed, 403 forbidden, 413 too large, 422 invalid) → **failed queue**, surfaced
  in UI; after inspection or 8 attempts → **DLQ** table, never retried automatically, exportable as JSON
  for support. Silently dropping a user's ops is the worst possible failure; DLQ makes loss *visible*.
- **Idempotency**: every push carries `Idempotency-Key: <batchId ULID>`. Server stores batch→result for
  24h; a replayed batch returns the original ack without re-committing. Belt (batch key) and braces
  (per-op unique id).
- **Checkpoint/resume**: `checkpoints[docId] = { lastServerSeq, lastPushedLocalSeq }`. Resume after
  30 days offline = `pull?since=lastServerSeq`. If the server has compacted past that seq (§8), it
  responds `410 Gone + snapshotUrl` → client does a **partial resync**: fetch snapshot, replay local
  unsynced ops on top (they're CRDT ops, so they merge — nothing is lost even after a 30-day divergence).
- **Sync lock** (C7): `navigator.locks.request('vellum:sync:'+docId)` — exactly one tab syncs a doc.
  Other tabs receive committed ops via `BroadcastChannel` (sub-millisecond, no server round-trip).
- **Network detection**: `navigator.onLine` is a liar (it reports "online" on a captive-WiFi portal).
  Truth = last successful request OR WS heartbeat within 20s. `onLine=false` is trusted (it's never
  wrong in that direction); `onLine=true` is treated as "maybe".
- **Background sync**: Service Worker + `SyncManager` where supported (Chromium), so a closed tab still
  drains its outbox. Elsewhere: `visibilitychange` + `online` + a 15s scheduler tick.

---

## 8. Compaction & snapshots (C5)

- Server writes an **auto-version** every 200 ops or 5 minutes of activity (whichever first) —
  a materialised `DocumentSnapshot` JSON + the `serverSeq` watermark it represents.
- Ops older than the newest snapshot that *all active sync sessions have acknowledged* are eligible for
  compaction. We keep them (history is a feature) but stop *shipping* them: new clients bootstrap from
  `snapshot + ops after watermark`, an O(1) open regardless of document age.
- Tombstone GC inside the CRDT happens **only** at snapshot materialisation, and only for chars deleted
  below the watermark that every session has acked. Under-approximating (keeping a tombstone too long)
  costs memory; over-approximating (dropping one a client still needs as an origin) costs *correctness* —
  so the watermark is deliberately conservative, and a client that falls behind it gets `410 Gone` and
  a clean resync instead of a silently corrupt merge.

---

## 9. Version history (C9)

Append-only. `versions` rows are `IMMUTABLE` (enforced by a Postgres rule + no update path in the repo layer).

| Feature | Implementation |
|---|---|
| Auto snapshot | every 200 ops / 5 min, `kind = AUTO` |
| Named snapshot | user action, `kind = NAMED`, label + description |
| Preview | render `version.content` read-only in a side panel — no state mutation |
| Diff | block-level LCS (Myers) → per-block word-level diff; renders as green/red inline |
| Restore | **compute the op set that transforms current → target, emit as NEW ops.** History untouched. A concurrent editor's in-flight ops merge with the restore ops through the same CRDT — a restore is not a special case in the merge engine, which is exactly why it can't corrupt a live session. |
| Rollback | restore-to-parent — same mechanism, `kind = RESTORE`, `parentVersionId` set → a git-like DAG |
| Timeline | `versions` ordered by `serverSeq`, grouped by day, with author avatars |

---

## 10. Security (C8)

| Threat | Control |
|---|---|
| Massive payload / OOM | `Content-Length` cap 1MB at middleware, 512KB per batch, 500 ops/batch, 32KB/op, 100k chars/block, 5k blocks/doc — enforced **before** JSON parse. Body read as a capped stream, not `await req.json()` on an unbounded body. |
| Malformed JSON | `zod.strict()` on every payload; parse failure → 400 + audit log, never a 500. |
| Replay | `operationId` UNIQUE + batch idempotency keys + `documentVersion` sanity window. Re-sent ops are no-ops. |
| Spoofed identity | server **overwrites** `op.userId` from the JWT session. Client-asserted identity is a hint, never a fact. |
| Unauthorised sync | every push/pull/WS-join runs `authorize(userId, documentId, action)` against `collaborators`. Viewer role → push rejected 403 (viewers cannot edit, sync, restore, or delete). |
| Tenant isolation | no repository method takes a bare `documentId` — every one takes `(actor, documentId)` and joins through `collaborators`. Not-a-collaborator ⇒ `404`, not `403` (don't leak existence). |
| SQL injection | Prisma parameterised queries only. Zero raw SQL except one `$queryRaw` for the gapless sequence, with typed params. |
| XSS | Document content is **structured JSON**, never HTML. Zero `dangerouslySetInnerHTML`. AI output is text, inserted as CRDT text ops (so it can't inject markup). Strict CSP header. |
| CSRF | Auth.js `__Host-` cookies, `SameSite=Lax`, and the sync API is JSON-only + requires a bearer/session check (a form POST can't forge it). |
| DoS / rate limit | Postgres-backed sliding window (serverless-safe): 600 ops/min and 60 requests/min per user; WS: 100 msg/s per socket then disconnect. 429 with `Retry-After` → client backoff (which already exists — the abuse control and the offline control are the same code path). |
| Audit | every privileged mutation (share, role change, restore, delete) → `audit_logs`, append-only. |

---

## 11. Performance (C1)

Measured, not asserted. `pnpm bench` runs the real keystroke path — mint the operation, fold it into the
CRDT, re-derive the rendered view — on a 500-block document, and fails the build if it regresses.

| | before | after |
|---|---|---|
| keystroke, 500 blocks (p50 / p99) | 19ms / 135ms | **0.36ms / 1.3ms** |
| keystroke, 2,000 blocks (p50) | — | **0.82ms** |
| 1,000-operation batch (catch-up, AI rewrite, restore) | 68ms | **2.7ms** |
| 16,000-operation batch (a week offline) | ~90s (extrapolated) | **44ms** |

The "before" column is what this document used to *claim* was fast. The benchmark was written to defend
the claim and immediately refuted it — the four bugs it found are in TASKS.md, and the fixes are D-015 and
D-016. A performance claim with no test behind it is a wish.

The last row is the one that would have hurt. Two quadratics were stacked on the batch path — the
per-operation state copy, and (hiding behind it) the linear scan in the character-level idempotence check,
which asks "do I already have this character?" and pays for the whole block to hear "no". Neither is
visible on the ten operations a unit test folds. Both are ruinous on the thousands a real reconnect
delivers, which is the moment the user is staring at a spinner.

**What makes a keystroke cheap:**

- **One `contenteditable` per block**, memoised on the block's identity. A keystroke dirties one block, so
  one component re-renders whether the document has 5 blocks or 5,000.
- **The rendered projection is cached per block**, keyed on Block identity in a `WeakMap`. This is the part
  that was missing, and the memo above could not compensate for it: `render()` was rebuilding every
  character of every block on every keystroke, *upstream of React*. Memoising a component is worthless if
  you rebuild its props from scratch first. Because `apply()` is persistent, object identity is an exact,
  free content hash — and the cache also hands React the *same* object for unchanged blocks, so `memo`
  short-circuits on reference equality.
- **A batch is folded into one draft** (D-015): one Map copy per batch rather than per operation. This is
  what turns hydration and reconnect-catch-up from quadratic into linear.
- **Deduplication lives on the Replica** (D-016), so the forever-growing set of seen operation ids is never
  copied on the hot path.
- **`content-visibility: auto`** skips layout, paint and style for off-screen blocks — the entire win of a
  JS virtualiser — while keeping the node in the DOM, so Ctrl+F, screen readers, `#anchor` links and
  Select-All keep working. The hand-written virtualiser this replaced has been deleted.
- Server Components + Suspense for the app shell; the editor is a client island, code-split, hydrated from
  the local snapshot immediately (no server round-trip to first paint).
- React Compiler enabled → no manual `useMemo` noise, and no bailout-hostile patterns either.

**The honest bound.** A keystroke is O(blocks), not O(1): the draft copies the blocks Map once per batch.
At the 5,000-block cap that is roughly 2.5ms — inside the 8ms budget, but not free. Text is stored as **one
RGA node per character**, not run-length-collapsed; a 400-character paragraph is 400 nodes. Both are
deliberate: the plain array is what makes the merge engine simple enough to fuzz-test and reason about, and
the benchmark says neither is the bottleneck. If a document ever outgrows them, the benchmark is where that
will show up first, and it asserts the *scaling laws* (a 10× document must not cost 10× per keystroke;
doubling a batch must not more-than-double its cost) precisely so that it fails on a regression rather than
on a busy CI runner.

---

## 12. AI (`backend/src/ai/` + `frontend/src/components/ai/`)

AI is not a text box glued to the side; it is a **first-class op producer**. Every AI mutation goes
through the same `OpFactory` as a keystroke, which means AI edits are: offline-queued, undoable,
collaboratively merged, versioned, and audited — for free, because they aren't a special case.

- Streaming via Anthropic SDK (`claude-sonnet-5`) → `ReadableStream` from a Node route handler.
- Actions: rewrite, improve, summarise, translate, fix grammar, change tone, extract action items,
  meeting notes, continue writing, explain selection, generate title, document insights.
- Every call is logged to `ai_history` (prompt, action, model, tokens in/out, latency, documentId,
  selection range) — for cost attribution, abuse detection, and the in-app "AI usage" panel.
- Rate limited per user. Prompt-injection posture: document content is passed as *data* in a clearly
  delimited block with an instruction not to follow instructions inside it, and AI output is inserted
  as **plain text ops** — it can never execute, style, or escape.

---

## 13. Testing strategy

| Layer | Tool | What it proves |
|---|---|---|
| Property/fuzz | Vitest + fast-check | **Convergence.** N replicas, random ops, random delivery orders/duplicates ⇒ identical state. The single most important test in the repo. |
| Unit | Vitest | RGA insertion order, HLC monotonicity, backoff+jitter bounds, diff correctness, zod caps |
| Integration | Vitest + Testcontainers Postgres | push/pull idempotence, authz matrix (owner/editor/viewer × action), restore-creates-new-version, replay rejection, rate limits |
| E2E | Playwright | offline typing → reload → still there → reconnect → converged; two browser contexts editing concurrently; version restore; RBAC redirects |

---

## 14. Deployment

| Piece | Where | Why |
|---|---|---|
| Next.js app | Vercel | SSR/RSC/streaming, edge middleware |
| WS relay | EC2 + pm2 behind nginx | Vercel serverless cannot hold a socket (C10) — the relay needs a long-lived process. Single instance today; multi-instance fanout would go via Postgres `LISTEN/NOTIFY` (adequate to ~10k concurrent; Redis pub/sub beyond). |
| Postgres | Neon | serverless driver + branching for preview envs |
| CI | GitHub Actions | lint → typecheck → unit → integration (containers) → build → e2e → deploy |

Local dev: a local Postgres + `pnpm dev` in each repo (Next on :3000, API + WS relay on :4000).

---

## 15. Known weaknesses (honest list)

1. **Hand-rolled CRDT** is more risk than adopting Yjs. Mitigated by property-based convergence tests,
   not by confidence. If the fuzz test ever fails, the algorithm is wrong and the algorithm loses.
2. **Per-character mark storage** costs memory on heavily formatted long documents. Bounded by
   run-length collapsing of identical mark maps.
3. **`LISTEN/NOTIFY` fanout** ceilings out around 8k NOTIFYs/sec. Documented, with the Redis swap
   isolated behind a `Broadcaster` interface so it's a one-file change.
4. **Block-level move is LWW-on-position.** Two users concurrently moving the *same* block to different
   places: one wins deterministically. This loses no *content*, only a position — an acceptable, explicit
   trade (the alternative, a move-tree CRDT, is a large complexity spend for a rare event).
