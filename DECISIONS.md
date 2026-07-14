# DECISIONS.md — Architecture Decision Records

Every entry: the choice, the alternatives that were seriously considered, the axes they were scored on
(scalability · complexity · performance · memory · failure recovery · offline · maintainability · security),
and the reason the winner won. Reversal cost is stated, because a decision without an exit plan is a bet,
not a design.

---

## D-001 — Two standalone repos; the merge engine has exactly one implementation
**Status:** accepted (revised — originally a pnpm monorepo with a shared `core` package)

**Constraint:** `frontend` and `backend` must be independent repositories. No workspace, no shared
package. This was a product decision, and it is a reasonable one — the two services deploy on
different platforms, on different cadences, with different runtimes.

It creates a real problem. A merge algorithm that runs in two places and differs *even slightly*
produces divergence that is close to undebuggable: the client says the document is X, the server says
it is Y, both are internally consistent, and neither is wrong. Three options were considered:

| Option | Merge-drift risk | Release friction | Server can verify snapshots | Verdict |
|---|---|---|---|---|
| Duplicate `crdt/` in both repos + CI hash-parity check | ⚠️ guarded by a CI job, i.e. by a thing people disable when it's noisy | none | ✅ | rejected |
| Publish `@vellum/core` to npm from a third repo | ✅ none | ❌ a publish cycle on every merge-engine bugfix, and a third repo | ✅ | rejected |
| **Server never runs the CRDT** | ✅ **structurally impossible** — there is only one implementation | none | ❌ | **chosen** |

**Chosen:** the backend is a dumb ordered log (D-005). It validates, authorizes, deduplicates,
sequences, persists, broadcasts. It does not fold operations into state, does not merge, does not
transform. The CRDT exists **only** in the frontend, so "the two implementations drifted" is not a
bug that can be written.

The backend still needs the *wire contract*, so it duplicates ~100 lines of zod op schemas. That is a
deliberate duplication of a **contract**, not of an **algorithm**, and the two failure modes are not
comparable: a drifted contract fails loudly with a 422 at the door; a drifted merge algorithm fails
silently, months later, as two users staring at different documents.

**What this costs, stated plainly:** the server cannot independently verify that a version snapshot
uploaded by a client is a faithful fold of the operation log. Mitigation: snapshots are a **cache**,
never a source of truth. The oplog is authoritative, snapshots are always rebuildable, and any client
can detect a bad one by replaying. A malicious client can poison its *own* bootstrap cache and
nothing else — it cannot alter what the log says, and the log is what everyone converges to.

**Reversal cost:** low. If server-side folding is ever needed (say, for server-rendered document
previews), the CRDT is a pure, dependency-free module that can be vendored or published without
touching the wire protocol.

---

## D-001b — Auth across the repo boundary: BFF token exchange
**Status:** accepted

Auth.js runs in the frontend and owns the session cookie. The backend is a different origin and
cannot read it. Options: (a) share the cookie via a common parent domain — brittle, and couples the
deploys; (b) put Auth.js in the backend — but the brief mandates Auth.js with Next.js, and it wants
the App Router; (c) **token exchange**.

**Chosen (c):** after Auth.js establishes a session, the frontend mints a short-lived (15 min) HS256
access token signed with a secret both services share. Every REST call and the WebSocket handshake
carry it; the backend verifies with `jose` and builds its `Actor` from the **verified claims only**.
The session cookie acts as the refresh token.

The access token is held **in memory**, never in `localStorage`. An XSS that can read `localStorage`
owns the account until the token expires *and* can exfiltrate it; a token in a closure dies with the
tab. The 15-minute lifetime bounds the damage of a leak to 15 minutes.

The frontend has **no database access at all**. Auth.js's callbacks create and look up users through
service-token endpoints on the backend. One process owns Postgres, which is what makes the tenant
isolation claim in D-011 auditable instead of aspirational.

---

## D-002 — Hand-rolled operation-based CRDT, not OT, not Yjs, not LWW
**Status:** accepted · **this is the load-bearing decision of the system**

| Option | Scalability | Complexity | Perf | Memory | Failure recovery | Offline | Maintainability | Security |
|---|---|---|---|---|---|---|---|---|
| **LWW on document/block** | ✅ trivial | ✅ trivial | ✅ | ✅ | ✅ | ⚠️ works, but | ✅ | ✅ |
| **OT (Google-Docs style)** | ⚠️ server must transform every op; central bottleneck | ❌ TP1/TP2 correctness is famously hard; most published OT is subtly wrong | ✅ | ✅ small (no tombstones) | ❌ a client that misses one op is permanently desynced; needs strict ordered delivery | ❌ hostile — long offline divergence means transforming against a huge history | ❌ | ⚠️ |
| **Yjs / Automerge (adopt)** | ✅ | ✅ (someone else's) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Hand-rolled op-based CRDT (RGA + fracindex + LWW-registers)** | ✅ no server transform; server is a dumb ordered log | ⚠️ real, but bounded | ✅ | ⚠️ tombstones (bounded, §8) | ✅ order-independent, duplicate-safe, resumable | ✅ **native** — offline is just "ops not yet shipped" | ✅ ~600 LOC, fuzz-tested | ✅ |

**LWW is disqualified outright**, and not merely because the brief forbids it: with LWW, two people typing
in the same paragraph while offline means one of them loses *everything they wrote*. That is data loss, and
data loss is not a merge strategy.

**OT is disqualified** on offline and on failure recovery. OT assumes a well-ordered stream of ops through a
central transformer. A client that has been offline for three days re-enters with 4,000 ops that must be
transformed against 30,000 server ops — quadratic, fragile, and the exact scenario this product is *for*.
OT is the right answer for a system where clients are always online; it is the wrong answer for a local-first one.

**Yjs would be the correct choice in a real company** — battle-tested, and I would ship it in production
without hesitation. It is rejected *here* because the assignment's explicit deliverable is a deterministic
merge algorithm with the merge decisions explained. Adopting Yjs means the interesting part of the system is
a dependency. So: hand-rolled, with the honesty that the mitigation for hand-rolled-CRDT risk is not
confidence but a **property-based convergence fuzz test** (N replicas × random ops × random delivery
permutations ⇒ byte-identical state) that runs in CI on every commit. If that test fails, the algorithm is
wrong. That test is the real proof; everything else is an argument.

**Nuance that matters (and is the actual design insight):** "no LWW" applies to *authored content*. It does
not, and should not, apply to *scalars*. For `heading.level = 2` vs `3`, there is no merge — one must win,
and LWW-with-HLC picks a winner deterministically while losing nothing a human typed. So the system uses
**the weakest primitive that cannot lose data, per data shape**: RGA for text (additive — both survive),
fractional index for block order, LWW-register for attributes and marks. Using RGA for a boolean is waste;
using LWW for prose is destruction.

**Reversal cost:** medium. `core/merge` sits behind a `MergeEngine` interface; swapping in Yjs would be a
rewrite of one package and a migration of stored ops, with the wire protocol unchanged.

---

## D-003 — RGA for character sequences, with ids minted from a Lamport clock
**Status:** accepted (revised during implementation — the property test found the first version wrong)

### The bug, kept on the record because it is the most instructive thing in this repo

The first implementation ordered character ids **descending by counter**, and allocated those counters
from a **per-replica** sequence. Both were wrong, and the convergence fuzz test caught it on the first
run. Three replicas typing `<0>`, `<1>`, `<2>` at the same caret produced:

```
A<<<B012>>>          ← every replica agreed. on garbage.
```

**Convergence held. The result was still worthless.** That is the lesson: convergence is the floor,
not the goal. A CRDT that shreds two people's concurrent words into each other is technically correct
and practically unusable, and *no amount of "all replicas match" testing would have caught it* — only
an assertion about what the text should actually look like did.

**Root cause.** RGA's insertion scan walks right from the origin, skipping siblings whose id is
greater. That is only safe if a character's id is **always greater than its origin's id**, because
that invariant is what makes "skip a sibling" implicitly skip that sibling's entire subtree (every
descendant has an even larger id, so the scan keeps walking). Break the invariant and the scan can
halt *inside* another user's run — splitting their word.

I broke it twice:
1. **Descending order** inverted the skip rule.
2. **Per-replica counters** made the invariant flatly false: a fresh replica at counter 1, anchoring
   to a character with counter 500 authored by a replica that had raced ahead, mints a child whose id
   is *smaller than its own parent's*.

**The fix.** Character ids are minted from the replica's **Lamport clock**, advanced past every
character it observes (including the counters *consumed* by an observed run — a 5-character insert
starting at 40 occupies 40–44). Ordering is ascending by `(counter, clientId)`. The invariant now
holds by construction rather than by luck, subtree-skipping works, and runs stay contiguous:
"helloworld" or "worldhello", deterministically, never "hweolrllod".

### Why RGA at all

Candidates: RGA, Logoot/LSEQ (dense position identifiers), Fugue/Peritext, WOOT.

- **Logoot/LSEQ** avoid tombstones but grow position identifiers without bound under sustained editing
  (a hot paragraph accumulates 40-byte-per-char positions) and interleave badly.
- **WOOT** is provably correct and unusably slow (O(n) scans with visibility checks per operation).
- **RGA** keeps tombstones (bounded by snapshot GC, ARCHITECTURE.md §8), is a simple array splice with
  a scan bounded by *paragraph* length (not document length), and — with the Lamport-clock invariant
  above — is anti-interleaving.

**Reversal cost:** high. It *is* the data model. Which is precisely why the fuzz test runs on every
commit: 500 generated histories × up to 5 replicas × random delivery orders × duplicates. If it ever
fails, the algorithm is wrong and the algorithm loses.

---


---

## D-004 — Fractional indexing for block order, not a sequence CRDT
**Status:** accepted

Block reordering is coarse-grained (drag a paragraph) and concurrent reorder of the *same* block is rare.
Fractional indices (Figma/Linear) give O(1) insert-between, compact keys, and trivial reasoning. Concurrent
inserts landing on the *same* index are broken by the total order `(fracIndex, operationId)` — deterministic
on every replica. Concurrent *moves* of one block resolve LWW-by-HLC: a position is lost, never content.
A move-tree CRDT (Kleppmann) would preserve both intents, at a complexity cost that is not justified by the
frequency of the event. **Explicitly accepted trade, documented in ARCHITECTURE.md §15.**

---

## D-005 — Server is an ordered, idempotent log — not an authority on content
**Status:** accepted

The server never transforms, never merges, never rewrites an op's semantics. It: authenticates, authorises,
validates, deduplicates, assigns a gapless per-document `serverSeq`, persists, broadcasts.

This is what makes the whole system tractable: **`serverSeq` is the only cursor any client ever needs.**
Resume-after-a-month, resume-after-a-crash, resume-after-a-tab-close, and first-open are all the same code
path — `pull?since=<seq>`. Nothing else in the sync engine needs to be clever, because the hard problem
(merge) was already solved in D-002 and lives on both sides of the wire.

**Reversal cost:** low — the server is deliberately dumb.

---

## D-006 — WebSocket is an accelerator over the HTTP protocol, never a second protocol
**Status:** accepted

The WS relay ingests ops and runs the **identical commit pipeline** as the HTTP route, then broadcasts.
Clients treat WS-delivered ops exactly like pulled ops (dedupe by `operationId` makes double-delivery
harmless by construction).

Consequence: if the socket is blocked (corporate proxy), degraded, or the relay is down, the product still
works — sync latency degrades from ~50ms to the poll interval, and nothing else changes. A system whose
correctness depends on a WebSocket staying up is a system that is broken on hotel WiFi.

---

## D-007 — Split deployment: Next on Vercel, WS relay on Fly
**Status:** accepted

Vercel's serverless functions cannot hold long-lived sockets. Options: (a) Pusher/Ably — vendor lock-in and
per-message billing, and the collaboration engine becomes someone else's black box; (b) SSE + HTTP POST —
works on Vercel, but no back-pressure and a connection per user per doc; (c) a small Node WS process on Fly.

Chose (c): ~200 lines, stateless, horizontally scalable, and it lets the relay run the same `core` pipeline.
Multi-instance fanout uses Postgres `LISTEN/NOTIFY` (no new infrastructure) behind a `Broadcaster` interface;
the Redis-pub/sub swap at scale is a one-file change. Documented ceiling: ~8k notifies/sec.

---

## D-008 — IndexedDB via Dexie, in-memory CRDT as the render source
**Status:** accepted

IndexedDB is durable but async and slow relative to a frame budget. If a keystroke awaits IDB, typing jitters
at exactly the moment the user notices — under load. So: the in-memory CRDT is the source of truth *for
rendering*, IDB is a **write-behind append log** (flushed on idle / every 250ms / forced on `pagehide`).

Worst case on a hard kill: the last ≤250ms of keystrokes are lost. Blocking every keystroke on a disk write
to avoid that is the wrong trade, and it is the trade every "local-first" demo that feels laggy has made.

Dexie over raw IDB: transactions, schema versioning, and a typed API. Raw IDB here is ceremony without benefit.

---

## D-009 — Custom block editor, not Tiptap/ProseMirror
**Status:** accepted · **highest-risk decision after D-002**

| Option | Complexity | CRDT integration | Control | Risk |
|---|---|---|---|---|
| ProseMirror/Tiptap | ✅ mature | ❌ PM owns its own transactional document model; binding a *custom* CRDT means writing the equivalent of `y-prosemirror` — a notoriously subtle piece of software — and fighting PM's model at every step | ⚠️ | ❌ |
| contenteditable on the whole document | ❌ | ❌ browser normalises the DOM under you | ❌ | ❌❌ |
| **Block-scoped contenteditable, CRDT-driven** | ⚠️ real work | ✅ direct: `beforeinput` → precise range → op | ✅ total | ⚠️ manageable |

Chosen: one `contenteditable` per block. `beforeinput` gives the exact intent (`insertText`,
`deleteContentBackward`, `insertFromPaste`…) with a precise range **before** the DOM mutates, which maps
cleanly onto CRDT ops without DOM-diffing. Rendering is React from CRDT state; the DOM is never the truth.

This is also the honest answer to "why not just use Tiptap": with a bespoke CRDT, the editor binding is the
integration, and doing it against PM's model is *more* work than doing it directly — with worse determinism.

**Reversal cost:** high. Contained: the editor talks to `core` only through `OpFactory` + `DocumentStore`.

---

## D-010 — Restore emits new forward ops; history is immutable
**Status:** accepted

`restore(v3)` computes the op set transforming `current → v3` and appends it as **new ops** with a new
version row (`kind = RESTORE`, `parentVersionId = v3`). Nothing historical is mutated or deleted.

Why not "reset document state to v3": that is a whole-document LWW write — it silently annihilates any
concurrent collaborator's in-flight edits, and it can't converge (two replicas restoring different versions
concurrently would diverge). As forward ops, a restore merges through the *same* CRDT as a keystroke, so a
concurrent restore + concurrent typing produces one deterministic result on every replica. **Restore is not
a special case in the merge engine, and that is precisely why it is safe.**

Side benefit: undo of a restore is free, and version history becomes a git-like DAG (`parentVersionId`).

---

## D-011 — Per-op authorization, no bare-`documentId` repository methods
**Status:** accepted

Every repository method's first argument is the actor. There is no `documents.findById(id)` — only
`documents.findForActor(actor, id)`, which joins through `collaborators`. Tenant isolation is therefore a
property of the *type signature*, not of a developer remembering to check. A missing authz check becomes a
compile error rather than a breach.

Not-a-collaborator returns **404, not 403** — a 403 confirms the document exists, which leaks the existence
of private documents to anyone who can guess an id.

The client-supplied `op.userId` is **overwritten** from the JWT session server-side, always. It exists on the
wire only so local, unsynced ops can be attributed before the server has seen them.

---

## D-012 — Postgres-backed rate limiting, not in-memory
**Status:** accepted

Serverless route handlers have no shared memory; an in-memory limiter on Vercel is decorative. A sliding
window in Postgres (`rate_limits` table, one upsert per request) is correct across instances and needs no
new infrastructure. Cost: one extra write per request — acceptable at this scale, and swappable for Upstash
Redis behind the `RateLimiter` interface when it isn't.

The abuse path and the offline path share the same client code: a 429 with `Retry-After` feeds the *existing*
exponential backoff. One mechanism, two purposes.

---

## D-013 — Size limits enforced before parse, not after
**Status:** accepted

`await req.json()` on a 900MB body has already OOM'd the process by the time any validator runs. The body is
read as a **capped stream** (1MB hard limit at the middleware) and rejected with 413 before a parser ever sees
it. Zod then enforces semantic caps (500 ops/batch, 32KB/op, 100k chars/block, 5k blocks/doc).

Validation is defence in depth, not a substitute for not reading the bytes in the first place.

---

## D-014 — AI mutations are ordinary CRDT ops
**Status:** accepted

An AI rewrite produces `text.delete` + `text.insert` ops through the same `OpFactory` as a keystroke.

Therefore, for free and with no special-casing: AI edits are undoable, offline-queued, merged with
concurrent human edits, versioned, attributable in history, and audited. The alternative — AI writing directly
to document state — would need its own merge, its own undo, its own offline story, and would be the one code
path in the system that can destroy a collaborator's concurrent edit.

Prompt-injection posture: document content is passed as delimited *data*; model output is inserted as plain
text ops, so it cannot inject markup, styles, or executable content even if the model is fully compromised.

## D-015 — Batch application: move the copy boundary, don't abandon immutability

**Decision.** `Replica.ingest` folds an entire batch into one `Draft`: the blocks Map is copied once, each
*touched* block is cloned once, and every subsequent write in that batch mutates the clone. `commit()`
publishes one new state whose untouched blocks are still shared by reference with the previous one.

**Why.** The original `apply()` was persistent per *operation* — every single operation copied the whole
blocks Map and the target block's entire character array. That is a fine price for one keystroke and a
catastrophic one for a batch: replaying N operations into a block copies the array N times at growing
length, which is O(N²). A benchmark measured it — doubling a batch made it 5.5× slower — and the paths
that hit it are the ones where the user is already waiting: hydrating a document from its log, catching up
after a week offline, an AI rewrite, a version restore.

**Alternatives.**
- *Keep per-op persistence.* Simplest, and the profile says no: the cost is not constant-factor, it is the
  wrong complexity class, on the exact paths that matter most.
- *A persistent data structure (HAMT / RRB-tree) for blocks and chars.* Genuinely O(log n) with structural
  sharing and no mutation anywhere. It is also a new data structure to implement, test, and debug in the
  most correctness-critical file in the system, to solve a problem that a copy boundary solves with thirty
  lines. The CRDT is where bugs are silent and permanent; it is the last place to add cleverness.
- *Mutate the live state in place.* Fastest and unacceptable. Snapshots, version previews, and the render
  cache all hold states handed out earlier, and every one of them would rot underneath its holder.

**The three invariants** (stated in the code, and each load-bearing):
1. **Only clones are mutated** — a state handed out earlier never changes.
2. **Characters are replaced, never edited** — a delete writes a new `{...char, deleted: true}` into the
   owned array rather than flipping a flag on a Char object the previous state still points at.
3. **Validate fully, then mutate** — an operation checks every dependency before it touches the draft, so
   an operation that turns out to be `pending` (its anchor has not arrived yet) leaves no partial write
   behind. Without this, out-of-order delivery would corrupt state — a bug that appears only in production.

**How it is held.** A convergence test captures a state's canonical serialisation, applies every kind of
operation on top of it in one batch, and requires the old serialisation — and the old Block object, char
array, tombstones and marks — to be byte-identical afterwards. The 500-history fuzz test still passes
unchanged, which is the real proof that the merge semantics did not move.

**Cost, stated honestly.** A keystroke is now O(blocks), not O(1): one Map copy per batch. At the
5,000-block cap that is ~2.5ms, inside the 8ms budget. It is not free, and the number is written down
rather than rounded to "constant time".

## D-016 — Deduplication belongs to the Replica, not to the document

**Decision.** The set of applied operation ids lives on `Replica`, not inside `DocumentState`. `apply()` no
longer deduplicates; `Replica.ingest` — the one boundary every operation enters through (WebSocket, HTTP
pull, cross-tab BroadcastChannel, local edit) — checks the set before folding and adds to it after.

**Why.** Two reasons, and the second is the one that forced it.

*Correctness of comparison.* Two replicas holding an identical document should compare equal. With the
dedup index inside the state, they differ whenever they have *received* different duplicates — a difference
in network history, not in the document. The document's value should describe the document.

*Cost.* The set grows with every operation ever applied and never shrinks. Keeping it in a persistent state
meant copying it on every keystroke: an O(session history) term on the hot path — invisible on a fresh
document, and a tax that grows all afternoon. After 50,000 keystrokes it is copying a 50,000-element Set
per character.

**The trade.** `apply()` is no longer idempotent *by itself*, which is a sharp edge: calling it directly on
an ingress path would double-apply a re-delivered insert. The guarantee is unchanged but it is now enforced
one layer out, at the only place a duplicate can actually arrive. The function says so, in the first line
of its doc comment, and the constructor that can seed a Replica with a pre-built state says what that costs
too. A guarantee enforced at the boundary is not weaker than one enforced everywhere — but it does have to
be *stated*, because the next person will assume the old contract.

## D-017 — Presence is state, not an event

**Decision.** A caret position is *remembered* at every layer that could fail to deliver it, and resent
when delivery becomes possible: in the editor (throttled with a leading edge), in `useDocument` (a ref
that survives a collaboration client which does not exist yet), and in the WebSocket client (resent on
every reconnect). Nothing about a caret is ever "missed"; it is only ever "not yet sent".

**Why.** Because presence was originally modelled as an *event* — "the user moved, so send a frame" — and
an event that cannot be delivered at the instant it occurs is simply lost. Five separate bugs came out of
that one modelling error, and every one of them presented identically to the user: **your colleague is
invisible, and there is nothing they can do about it except type.**

- Published only when the user *edited*, because caret movement inside a contenteditable fires no React
  event. A reader was invisible. Someone who clicked and pressed End was invisible.
- The 150ms "throttle" was a debounce, so continuous typing — the state in which you most want to see a
  collaborator's caret — cancelled and rebuilt the timer forever and published nothing at all.
- New selection *objects* on every DOM selection event tore down the effect holding that timer, including
  on the events the editor caused itself while restoring the caret.
- A caret placed before the socket finished connecting went to an optional chain on a null ref, and since
  presence was only resent on *change*, a caret placed once and left alone was never sent again.
- A caret that could not be *measured* (a background tab has no layout) was dropped rather than retried,
  and nothing re-measured when the tab came back.

**The general principle.** For anything ephemeral but *continuous* — cursors, selections, "who is here",
typing indicators — model the current value, not the transition. Then every failure mode collapses into
one recovery: send the current value when you can. A transition-based design needs a separate fix for
every way a transition can be lost, and the list above is what that costs.

**How it is held.** The E2E does the thing a user does: open a document in a second tab, click, press End,
and look at the first tab. It failed one run in three, and each investigation of "the flaky presence test"
turned up another one of the bugs above. The test was never flaky. The product was.
