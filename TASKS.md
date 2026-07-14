# TASKS.md

Living plan. Updated continuously. A phase is not "done" until its Definition of Done is met —
no phase is skipped ahead of, and nothing is left as a TODO in code.

**Legend:** `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked

---

## Phase 0 — Environment ✅ (backend)
- [x] Node 24.14.0 (Next 16 requires ≥20.9; the machine defaulted to v19 — switched via nvm)
- [x] pnpm 11.4.0 (no Docker — dev, CI and prod all run a real Postgres process)
- [x] **Two standalone repos** (revised from a monorepo — see D-001). Consequence: the server never
      runs the CRDT, so the merge engine has exactly one implementation and cannot drift.
- [x] backend: local Postgres (`vellum` + `vellum_test` databases), `.env.example`,
      generated dev secrets, strict tsconfig (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- [ ] backend: ESLint flat config (`no-explicit-any` = error, layering via `no-restricted-imports`)
- [ ] frontend: Next 16 scaffold, Tailwind 4, shadcn

## Phase 1 — Understand the problem ✅
- [x] Engineering challenges enumerated (ARCHITECTURE.md §1, C1–C10)
- [x] Non-goals stated explicitly

## Phase 2 — Architecture ✅
- [x] System shape, layering rules, repo layout (ARCHITECTURE.md §2–§3)
- [x] ADRs D-001…D-014 with scored alternatives (DECISIONS.md)
- [x] Known weaknesses documented honestly (ARCHITECTURE.md §15)

## Phase 3 — Database ✅
- [x] Prisma 7 schema, 13 tables: `User`, `Account`, `Document`, `Collaborator`, `Operation`, `Version`,
      `SyncSession`, `FailedOperation`, `AuditLog`, `AiHistory`, `RateLimit`, `IdempotencyKey`
- [x] Gapless per-document `serverSeq` via **advisory lock** (`pg_advisory_xact_lock`), not a Postgres
      SEQUENCE (sequences leave holes on rollback — a hole means a client waits forever for an op that
      will never arrive) and not `max(seq)+1` (races). Proven by a 20-way concurrent push test.
- [x] Indexes sized to the queries that exist. Dropped a redundant btree on `(documentId, serverSeq)`
      that duplicated the unique constraint — double write cost on the hottest table, zero read gain.
- [x] Soft deletes on `Document`; **immutability enforced by Postgres triggers** on `versions`,
      `operations`, `audit_logs` — verified: `UPDATE`/`DELETE` are rejected even from raw psql.
- [x] Repository layer — every method takes `(actor, …)`. There is no `findById(id)` in the codebase,
      so "forgot the permission check" is a compile error, not a breach (D-011).
- [x] **DoD met:** 37/37 green. Exhaustive authz matrix (3 roles × 5 actions), stranger-gets-404
      (no existence oracle), idempotent replay, partial-duplicate batch, gapless sequence under
      20 concurrent pushes, exclusive pull cursor, 410 Gone below the compaction watermark.
- Bug caught by the tests, not by review: `pg_advisory_xact_lock` returns `void`, which Prisma's
  `$queryRaw` deserialiser cannot map. Fixed to `$executeRaw`.

## Phase 4 — Sync protocol ✅
- [x] `Operation` wire contract + strict zod schemas (unknown key ⇒ 422, never a silent ignore)
- [x] `push` / `pull`, mandatory `Idempotency-Key`, `410 Gone` + resync semantics
- [x] Commit pipeline (validate → authorize → rate-limit → dedupe → sequence → persist → broadcast),
      shared by HTTP and (later) WS — one pipeline, so the socket cannot bypass a check HTTP enforces
- [x] Body cap enforced **pre-parse** (Fastify aborts mid-stream), Postgres rate limiter, error taxonomy
      carrying an explicit `retryable` bit (it drives the client's retry-vs-DLQ decision)
- [x] Fixed a self-inflicted bug: the per-user limiter was registered in `onRequest`, which runs
      *before* auth — so it silently keyed every authenticated user by IP. Split into an IP limiter at
      the door and an actor limiter after `requireAuth`.
- [x] **DoD met:** 21/21 live HTTP checks green (`scripts/smoke.ts`) — alg:none JWT forgery → 401,
      1.9MB body → 413 pre-parse, replayed batch → original acks + zero new commits, same key +
      different body → 422, stranger → 404 (no existence oracle), viewer → 403 on sync and delete.

## Phase 5 — Version history ✅
- [x] Snapshots (client-materialised, since the server does not run the CRDT) + compaction watermark
      that only ever moves **forward** (`GREATEST`) — a late-arriving snapshot must never drag it back
      and ask clients to re-fetch operations the server may no longer ship
- [x] Server refuses a snapshot whose watermark is **ahead of the log** — a bug or a forgery, and
      storing it would make every future client skip the operations in between
- [x] Two-level diff: block LCS over **content, not ids** (a restore re-creates blocks with fresh ids,
      so an id-based diff would report "everything changed" when nothing did) + word-level diff within
      changed blocks (a character diff of "cat"→"dog" is correct and unreadable)
- [x] **Restore = forward operations** (D-010), `parentVersionId` → a git-like DAG
- [x] **DoD met:** 10 frontend + 9 backend tests. The one that matters: *Alice restores an old version
      while Bob, offline, types a new paragraph.* Both replicas converge byte-identically, the restore
      lands, **and Bob's paragraph survives.** A `state = version.content` restore would have erased it
      silently — and would have passed any test that only asked "does restore restore".
- [x] Database refuses `UPDATE`/`DELETE` on `versions` — tested by going *around* the repository and
      trying it directly, because that is the actual threat (a "quick fix" endpoint, a psql session)
- Bug caught by the tests: my first diff decided "removal + addition = an edit" by peeking at whether
  the *next* blocks matched — a structural guess that breaks whenever a document ends with a new
  paragraph. Replaced with a real word-level similarity measure.

## Phase 6 — Conflict resolution / CRDT ✅
- [x] RGA text sequence with Lamport-minted character ids
- [x] Fractional index block order; LWW-registers (per key) for attrs and marks
- [x] Pending buffer for causal readiness, transitive drain, overflow ⇒ resync signal
- [x] **DoD met:** property test green — 500 generated histories × up to 5 replicas × random delivery
      orders × duplicates ⇒ byte-identical canonical serialisation, plus scenario tests for
      anti-interleaving, causally-reversed delivery, and delete-block-while-typing.
- **The fuzz test earned its keep on day one.** It failed on the first run: three replicas typing at
  one caret produced `A<<<B012>>>` — perfectly convergent word salad. Root cause: RGA requires
  `id > origin.id` globally (that invariant is what makes skipping a sibling skip its whole subtree),
  and per-replica counters + a descending order broke it. Fixed by minting character ids from the
  Lamport clock. **Convergence was never the bug — every replica agreed on the garbage.** See D-003.

## Phase 7 — Backend
- [ ] Auth.js (Google + credentials, JWT sessions, RBAC middleware)
- [ ] Route handlers: sync push/pull, documents, collaborators, versions, AI
- [ ] Streaming body cap (413 before parse — D-013), Postgres rate limiter, audit logging
- [ ] WS relay (`backend/`): JWT authz on connect, doc rooms, presence, LISTEN/NOTIFY fanout, heartbeats
- **DoD:** security checklist (ARCHITECTURE.md §10) has a passing test per row

## Phase 8 — Frontend 🟡 (editor working; polish + auth UI remain)
- [x] Design tokens (semantic, OKLCH), dark/light via next-themes, RSC landing page, skeletons
- [x] Block editor: native `beforeinput` → CRDT ops, `preventDefault()` on everything (the DOM never
      mutates before the CRDT does), id-anchored selections, markdown + inline shortcuts, slash menu,
      Enter-split / Backspace-merge, bold/italic/code shortcuts, plain-text paste → multi-block
- [x] **5/5 E2E against a production build, with NO backend running** — types, reloads, text survives
- [x] Three real bugs the browser found that review did not:
      (1) **React's `onBeforeInput` is not the native event** — the synthetic one has no `inputType`, so
          every keystroke fell through to `default` and was silently discarded;
      (2) `contenteditable="plaintext-only"` reports Enter as **`insertLineBreak`**, not `insertParagraph`;
      (3) handler props changed identity each render, **defeating `memo` on every block** — one keystroke
          would have re-rendered all 500 blocks, the exact linear degradation the memo exists to prevent.
- [ ] Tables, images, mentions
- **DoD:** typing p99 < 8ms on a 500-block document with the network offline —
      **met and measured: p50 0.36ms, p99 0.92ms** (`pnpm bench`). See *Performance* below for the three
      algorithmic bugs the benchmark found on its first run.

## Phase 9 — Collaboration ✅ (relay + presence; live cursors remain)
- [x] WS relay sharing the HTTP process, JWT-authorized at the **upgrade** (a rejected socket never
      becomes a socket), authorization re-checked **per room join** (a user removed mid-session stops
      receiving operations), per-socket flood control, 15s heartbeat with `terminate()` on a dead peer
- [x] **The relay has no write path of its own** — it calls the same `syncService.push` as HTTP, so the
      socket cannot bypass a check HTTP enforces (D-006)
- [x] WS client: reconnect with full-jitter backoff, presence, and *no coupling* — the socket is an
      accelerator, so if it never connects the document still syncs over HTTP
- [x] Presence UI: deterministic per-user colour (same person, same colour, on every screen), no email
      addresses leaked into the peer list
- [x] **8/8 realtime integration tests** against a real server + real socket + real Postgres:
      relay between two collaborators, **VIEWER can join but cannot write**, stranger → NOT_FOUND (not
      FORBIDDEN — no existence oracle), push-without-join → FORBIDDEN, forged token → refused at upgrade,
      malformed frame → error without dropping the connection
- [x] **BroadcastChannel cross-tab fanout + Web Locks sync lock** — two tabs of one document are two
      replicas on one device. They must not both sync (a checkpoint that moves out of order lets a pull
      skip a page of operations — silent, permanent loss dressed up as an optimisation), and they must
      see each other instantly without a server round trip for data already on the device.
- [x] **Live remote cursors** — drawn in an overlay, never injected into the contenteditable (that
      would corrupt the offsets the editor reads from the selection, and be clobbered by the next CRDT
      render). Positioned with a DOM `Range`, so it is correct through line wraps, bidi text and
      variable-width fonts — computing it from character widths would be re-implementing the browser's
      layout engine, badly. Anchored to a **character id**, not an offset: otherwise a colleague's caret
      would drift every time *you* typed above them.
- [x] Presence publishing is **throttled (150ms)** — a frame per keystroke is ~10/sec per person, and
      ten people in a document is 100 broadcasts a second to say what one frame later would say.

## Auto-snapshots ✅
- [x] Every 200 operations **or** 5 minutes of activity, whichever first. The operation count catches a
      burst (a big paste, an AI rewrite) that would otherwise leave a hole in the timeline; the timer
      catches a slow session that would otherwise have no restore points at all.
- [x] A failed snapshot does **not** reset the counter — it retries when the network returns. Resetting
      would mean an entire offline session silently produced no restore point, which is exactly when
      someone is most likely to want one.

## Virtualisation ✅ — replaced with `content-visibility`, and the JS virtualiser deleted
- [x] The first version was a real JS virtualiser: inert below 300 blocks, viewport ±30 blocks above it,
      with the focused block and any block holding a collaborator's caret **pinned** so a scroll could
      never unmount the node the editor was typing into.
- [x] It worked, and it was the wrong answer, for a reason I wrote down at the time and then acted on:
      **an unrendered block is not in the DOM, so Ctrl+F cannot find it.** People search their own
      writing constantly. Losing find-in-page — plus screen-reader reach, `#anchor` links, and Select-All
      over the whole document — is a permanent regression to buy a performance win.
- [x] **`content-visibility: auto` + `contain-intrinsic-size` gives the win without the trade.** The
      browser skips layout, paint and style for off-screen blocks — the entire benefit of a virtualiser —
      while the node **stays in the DOM**. Find works, a11y works, anchors work, Select-All works, no
      block needs pinning, and the whole `useVirtualBlocks` hook and its pinning logic were **deleted**.
      Less code, and strictly better behaviour.

## Performance ✅ — measured, and the benchmark immediately proved the README wrong
The claim was *"typing p99 < 8ms on a 500-block document"*. It was an assertion, not a measurement. The
first benchmark run reported **p50 = 19ms, p99 = 135ms, max = 439ms** — an order of magnitude over
budget — and found three separate algorithmic bugs, none of which review had caught:

- [x] **`render()` rebuilt the entire document on every keystroke** — every character of every block,
      O(total characters). The React `memo` on BlockView was doing its job perfectly and could not help,
      because the work happened *upstream of React*, in the function producing its props. Memoising a
      component is worthless if you rebuild its props from scratch first. → per-block projection cache
      keyed on Block identity (a `WeakMap`, so superseded blocks stay collectable). `apply()` is
      persistent, so object identity is a free and exact content hash.
- [x] **A `TEXT_INSERT` of N characters did N array splices** — O(N·n). A single splice of the whole run
      is not just faster, it is provably equivalent (each character in a run is anchored to its
      predecessor and has a greater id, so the run is always contiguous).
- [x] **Every operation copied the whole blocks Map and the target block's entire char array.** Fine for
      one keystroke; quadratic for a batch. Doubling a batch made it 5.5× slower — and batches are the
      paths where the user is *already waiting*: first load, catch-up after a flight, an AI rewrite, a
      version restore. → `Draft`: one Map copy per batch, each touched block cloned once and mutated
      thereafter. The copy boundary moved; immutability did not (D-015).
- [x] **A second quadratic, hiding behind the first.** With the copies fixed, per-operation cost was
      *still* doubling as the batch doubled (7µs/op at 1k operations, 46µs/op at 8k). The culprit was the
      character-level idempotence check — `findCharIndex(chars, charId)`, which asks "do I already have
      this character?" and, because the answer is nearly always *no*, reads the entire block to say so.
      → an O(1) id index, built once per block per batch. Only the second quadratic made the first one's
      fix visible; a benchmark that stopped at "it's faster now" would have shipped it.
- [x] **The applied-operation Set was copied on every keystroke** — and it grows with every operation
      ever applied, so keystroke cost rose with *session history*. Moved to `Replica`, where duplicate
      delivery actually arrives: dedup is a property of the network, not of the document (D-016).
- [x] **Result: p50 = 0.36ms, p99 = 1.3ms** on 500 blocks (was 19ms / 135ms). A 1,000-operation batch:
      **2.7ms** (was 68ms). A 16,000-operation batch — a week offline — folds in **44ms**; on the
      original code that was a minute and a half of frozen tab.
- [x] The benchmark asserts the *scaling laws*, not just the numbers — "a 10× larger document must not
      cost more per keystroke" and "doubling a batch must not more-than-double the time" — because those
      catch an algorithmic regression on any machine, while an absolute millisecond threshold mostly
      catches a busy CI runner.
- [x] It runs **alone** (`pnpm bench`, its own config, `fileParallelism: false`). Sharing cores with the
      fuzz test, it misreported a 2× batch as 4.6× *and* starved the convergence property test into a
      timeout — a red build caused entirely by the timing suite standing next to it. A measurement that
      perturbs what it measures is not a measurement.
- [x] **Honest remaining bound:** a keystroke is O(blocks), not O(1) — one Map copy per batch. At the
      5,000-block cap that is ~2.5ms, inside budget; it is not free, and it is written down rather than
      rounded to "constant time".

## Presence was broken in five different ways, and one flaky test found all of them
The E2E "a collaborator's caret appears in the document" failed about one run in three. It would have been
very easy to retry it. Every one of these is a bug a **user** would hit — a colleague who is simply
*invisible* to you — and none of them is a test artefact.

- [x] **1. Presence was only published on edits.** It was republished when `selection` state changed, and
      `selection` only changed when the user *typed*. React's `onSelect` does not fire for caret movement
      inside a contenteditable, and `onFocus` fires *before* the browser places the caret. So a peer who
      clicked into a paragraph and pressed End broadcast nothing, and a caret moved by arrow key kept
      advertising the position it had left. → listen to the document's `selectionchange`, the only event
      that reports this, with an id-based equality check so the editor's own caret restorations don't
      loop.
- [x] **2. The throttle was a debounce.** `setTimeout(150)`, rebuilt on every change, publishes 150ms
      after the user *stops*. While someone types continuously — keystrokes under 150ms apart, i.e.
      ordinary typing — the timer was cancelled and rebuilt forever and their caret was **never** sent.
      The one moment you most want to see where a collaborator is, is the moment they are typing; that
      was the one moment the design guaranteed you could not. → a real throttle, leading + trailing edge.
- [x] **3. Selection state churned object identity.** `setSelection(readSelection(block))` minted a new
      object on every DOM selection event, including the ones the editor triggers on *itself* restoring
      the caret. `selection` is a dependency of the presence effect, so each new object tore that effect
      down and rebuilt it — cancelling the timer before it could fire. Guarding with the same id-based
      equality made the fix in (2) actually hold.
- [x] **4. A caret placed before the socket connected was dropped, silently, forever.** `setPresence`
      went to `collabRef.current?.setPresence(...)` — an optional chain on a ref that is null until an
      async token fetch completes. Open a document, click into it within a few hundred milliseconds (i.e.
      normally), and your caret went nowhere; and since presence is republished when it *changes*, a
      caret that has been placed and left alone never gets another chance. → the caret is remembered in a
      ref and flushed when the client is constructed, and remembered again inside the client and resent
      on every (re)connect. **Presence is state, not an event.**
- [x] **5. A caret with no geometry was abandoned rather than retried.** The overlay measured *once*,
      when the presence frame arrived — and a background tab has no layout, so `getClientRects()` returns
      nothing and the caret was dropped. Nothing re-measured on the way back, because `peers` and `blocks`
      hadn't changed. Your colleague's caret was missing from a paragraph you were looking straight at.
      → bounded re-measure on a **timer** (not `requestAnimationFrame`, which doesn't fire in a tab the
      browser isn't rendering — the exact tab this exists for), plus re-measure on scroll and visibility
      change, which is also what `content-visibility` requires.

The lesson worth keeping: the test was not flaky. The product was. Every "flake" here was a real defect
whose reproduction depended on timing — which is also the definition of the bugs users report and
engineers cannot reproduce.

## Two more bugs, found while fixing the performance ones
- [x] **The client could mint an operation the server is guaranteed to reject.** The wire contract says
      `value: min(1)` on TEXT_INSERT; two client paths (an AI action returning an empty string, a history
      step replaying a run with nothing left in it) could produce `value: ""`. It would apply locally,
      push, earn a 400, retry, and land in the dead-letter queue — a sync failure surfacing hours
      downstream of its cause. The factory now **throws at the mint**, at the call site that is wrong.
      `apply()` separately tolerates an empty run as a no-op: **authoring is strict, parsing is
      forgiving** — a peer or a replayed log must never be able to crash the editor.
- [x] **A test that lied, one run in three.** The sync engine's backoff uses full jitter, and the engine
      let `Math.random()` through even though `backoff.ts` had taken an injectable `random` from the
      start *for exactly this reason*. The retry sometimes fired inside the window the test advanced its
      virtual clock through, so an assertion on `status === "backoff"` found `idle`. A virtual clock is
      only half a deterministic test if the delays are still random. → the engine takes its RNG as a
      dependency, like its clock.

## Undo / redo ✅ — and the three bugs it took to get right
- [x] **Local-origin only.** Ctrl+Z reverts *your* edit, never the document's last operation — otherwise
      you revert a colleague's sentence while their cursor sits in it.
- [x] **Undo is a forward operation, not a rewind.** You cannot un-delete a character: resurrecting a
      tombstone would silently undo a collaborator's deletion. Undo re-inserts the text as new characters.
- [x] **Bug 1 (caught by a 2-tab E2E): `clientId` was in `localStorage`, i.e. per-DEVICE.** A clientId is
      the namespace for character ids. Two tabs sharing one namespace both mint `abc:42` — for *two
      different characters*. That is not a merge conflict, it is the end of the CRDT's ability to reason
      about anything. **A tab IS a replica** → `sessionStorage`.
- [x] **Bug 2: seeding the first block before the first pull landed.** An empty local store does not mean
      an empty document — it means we have not pulled yet. Every fresh device invented a spurious
      paragraph that then synced and *duplicated* the real one. Fixed by seeding only after the first
      sync settles, with a **deterministic block id** so two replicas racing to seed produce the *same*
      operation (BLOCK_INSERT on an existing block is already a no-op — the race resolves itself using
      idempotency the engine already had).
- [x] **Bug 3: undo recorded a text snapshot, so it ate a collaborator's words.** Recording "block B said
      X, now Y" and undoing by restoring X **deletes everything they typed into that paragraph
      meanwhile.** Alice types AAA, Bob appends BBB, Alice hits Ctrl+Z → BBB gone. Fixed by recording the
      exact character ids the operation touched, plus a **remap** so an older stack entry can still find
      text a later undo re-created under new ids (without it: `v1`→`v2`→`v3`, undo, undo ⇒ `v1v2`).
- [x] 9 unit + 3 E2E. The unit tests alone would have shipped bug 3 — it only appears when the
      collaborator edits the **same block**, which is precisely what a single-context test cannot see.

## Phase 10 — Offline engine 🟡 (engine done; browser wiring + UI remain)
- [x] Dexie schema: append-only operation log, outbox (`serverSeq === null`), checkpoints, snapshots, DLQ
- [x] Sync state machine (idle → syncing → backoff → error), re-entrancy guard, `settled()` signal
- [x] Exponential backoff **with full jitter**; `Retry-After` obeyed over guessing; bounded at 8 attempts
- [x] Content-derived idempotency keys — stable across retries/reloads, and they *change* when the batch
      grows (a fixed key on a grown batch would earn a 422 from our own server)
- [x] Dead-letter queue: permanent failures are moved to disk **in the same transaction** that removes
      them from the outbox, so a crash between the two cannot lose a write. Loss must be loud.
- [x] **16/16 green against a deliberately hostile fake network**, including the nastiest real failure:
      *server commits, response is lost* → client retries → server dedupes → text is not doubled.
- [x] Two real bugs caught by these tests:
      (1) **Node 18+ defines a global `navigator` without `onLine`**, so `navigator.onLine` was
          `undefined` → falsy → the engine declared itself permanently offline in SSR and in tests;
      (2) my own test slept 10ms and hoped, hiding a race — replaced with an engine-provided
          `settled()` signal, because a flaky test is worse than no test.
- [ ] Web Locks (cross-tab sync lock) + BroadcastChannel (cross-tab op fanout)
- [ ] `online`/`offline`/`visibilitychange` listeners, Service Worker background sync
- [ ] UI: offline banner, sync progress, connection status, DLQ inspector
- **DoD:** kill the server mid-type → keep typing → reload → restart server → converged, zero loss (E2E)

## Phase 11 — AI ✅
- [x] Streaming over SSE (Anthropic `claude-opus-4-8`), 12 actions, `ai_history` (successes **and**
      failures — logging only the successes makes the failure rate invisible), per-hour AI rate limit
      denominated in *calls* (tokens are money in a way database rows are not)
- [x] **AI output → CRDT operations** (D-014) via the same `OperationFactory` as a keystroke
- [x] Prompt-injection posture: the document is fenced as **data**, and the output is inserted as
      **plain-text operations** — a fully compromised model still cannot inject markup, styles, or
      scripts, because the only thing the editor can do with the response is type it
- [x] Abort on tab-close/Escape — otherwise we keep pulling (and paying for) tokens nobody will read
- [x] A `refusal` is a 200 with empty content, not an exception — handled, so it surfaces as a message
      rather than looking like a bug in our editor
- [x] **DoD met:** 4 tests. The one that matters: *Alice runs an AI rewrite while Bob, offline, types
      in the same paragraph.* Both replicas converge byte-identically, the rewrite lands, **and Bob's
      sentence survives.** An AI that wrote directly to document state would have erased it silently.
- Checked the live API reference rather than writing from memory — and it mattered: the default model
  is `claude-opus-4-8`, and `budget_tokens` (my recalled thinking parameter) now returns a 400.

## Phase 7 — Auth ✅
- [x] Auth.js (Google + credentials, JWT session) in the frontend; **users live in the backend** behind
      service-token endpoints, so Postgres sits behind exactly one process
- [x] Token exchange: session cookie → 15-min HS256 access token, held **in memory only**
- [x] scrypt (N=2^15, ~64MB/guess) with **parameters stored per-hash**, so the cost factor can be
      raised later without logging everyone out
- [x] **15/15**, and the one that matters: *"both failures cost the same (128ms vs 128ms, ratio 1.00×)"* —
      without `fakeVerify()`, a missing user returns ~50× faster than a wrong password, and that timing
      difference alone is a scriptable user-enumeration oracle no error-message audit would catch
- [x] Middleware documented as **convenience, not a security boundary** — the real check is in the
      repository layer, on every request, against the database

## Phase 12 — Testing ✅
- [x] Property (fast-check) · Integration (real Postgres) · E2E (Playwright, real sign-in)
- [x] **E2E rewritten to be more honest:** it used to run with no backend at all. It now signs in for
      real, creates a real document, and *then severs the connection* — which is the failure a user
      actually experiences, not a hypothetical one. Plus a full round trip: type → Postgres → a fresh
      browser context with empty IndexedDB loads it back.
- **DoD met:** offline, merge, sync, restore, permissions, auth, AI all covered

## Phase 13 — Performance 🟡
- [x] Block memoisation with stable handler identities (one keystroke re-renders **one** block, at any
      document size), frame-batched remote ops, RSC shell + client island, code splitting
- [x] React Compiler lint surfaced three real violations, all fixed rather than suppressed: `setState`
      synchronously inside effects (cascading renders), and **refs read/written during render** —
      which under concurrent rendering can leak a value from a render pass React threw away
- [ ] Virtualisation above 300 blocks; a typing-latency benchmark in CI

## Phase 14 — Security review ✅
- [x] One test per row of the threat table (see README) — OOM, spoofed identity, replay, `alg:none`,
      viewer-writes (HTTP **and** WebSocket), enumeration by status code, **enumeration by timing**,
      prompt injection, history tampering
- [x] Layering enforced by the **linter**, not by hope: a route cannot import Prisma (it would bypass
      the authorization layer); a component cannot import the CRDT (it would bypass the single choke
      point that advances the Lamport clock — i.e. reintroduce D-003)
- [x] Helmet, strict CSP, CORS allowlist that **refuses to boot** with `*` alongside credentials

## Phase 15 — Deployment & docs ✅
- [x] GitHub Actions: lint → typecheck → test → build → E2E, against a **real Postgres**, with
      `migrate deploy` (not `db push`) so CI runs the same migrations production will
- [x] Dockerfile (multi-stage, non-root, `dumb-init` as PID 1 — without it Node never receives SIGTERM
      as PID 1 and the graceful shutdown never runs, so every deploy SIGKILLs mid-transaction)
- [x] `fly.toml` — **`auto_stop_machines = false`**: scale-to-zero would drop every WebSocket in every
      open document, and the cold start would be paid by whoever types next
- [x] README with architecture / merge / sync-state / ER diagrams, the security matrix, and the
      "what does this test actually prove" table
