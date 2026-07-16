# Vellum — Backend

The API and WebSocket relay for a local-first collaborative document editor.

**Live:** `https://api-vellum.paperflow.in` · **Frontend repo:** deploys separately to Vercel

```
Fastify 5  ·  Prisma 7  ·  PostgreSQL 18  ·  ws  ·  Zod 4  ·  TypeScript (strict)
EC2 + pm2 + nginx + certbot   —   no Docker anywhere
```

---

## Author & submission

Built by **Dileep Rajoriya** — House of Edtech, Fullstack Developer Assignment 2.

| | |
|---|---|
| 🌐 **Live demo** | https://vellum.paperflow.in |
| 🔌 **Live API** | https://api-vellum.paperflow.in |
| ⚙️ **Backend repo** | https://github.com/Er-Dileep-rajoriya/vellum-backend |
| 💻 **Frontend repo** | https://github.com/Er-Dileep-rajoriya/vellum-frontend |
| 👤 **GitHub** | https://github.com/Er-Dileep-rajoriya |
| 🔗 **LinkedIn** | https://www.linkedin.com/in/dileep-rajoriya-a63a561ba/ |

---

## The one idea that explains this whole codebase

**The server never runs the merge algorithm.**

It is a *dumb, ordered, idempotent log*. On the write path it does exactly six things:

```
validate → authorize → rate-limit → dedupe → assign serverSeq → persist → broadcast
```

It never folds operations into document state, never merges, never transforms, never resolves a conflict.
All of that happens in the client's CRDT.

This is not laziness — it is the decision that makes two separate repositories *safe*. The merge algorithm
has exactly one implementation, so "the client and server merge implementations drifted" is not a bug that
can be written here. What the backend duplicates is ~100 lines of Zod **wire schemas**: a drifted
*contract* fails loudly with a 422 at the door, while a drifted *algorithm* fails silently, months later,
as two people stare at different documents.

The cost, stated honestly: the server cannot verify that a client's version snapshot is a faithful fold of
the log. So snapshots are treated as a **cache, not a source of truth** — the operation log is
authoritative, and any client can rebuild and check a snapshot by replaying it.

---

## Features

### Sync (the core)
- **Append-only operation log.** Documents *are* a fold of their operations. Nothing is ever updated in
  place.
- **Gapless `serverSeq` per document** via `pg_advisory_xact_lock` — not a Postgres `SEQUENCE` (sequences
  leave holes on rollback, and a hole means a client waits forever for an operation that will never
  arrive) and not `max(seq)+1` (races). Proven by a test that pushes **20 concurrent batches** and asserts
  no holes.
- **Structural idempotency.** Every operation carries a ULID `operationId` (UNIQUE), and every batch
  carries an `Idempotency-Key`. Replaying a batch returns the *original* acknowledgements and commits
  nothing new. Same key + different body → **422**, so the cache cannot be poisoned.
- **`410 Gone` + resync** when a client's cursor falls below the compaction watermark.
- **Cursor-exclusive pull** (`since=N` returns `N+1` onward).

### Realtime
- **WebSocket relay** with rooms per document, presence, heartbeats, and per-socket flood control.
- **The relay has no write path of its own.** It calls the same `syncService.push` as HTTP, so a socket
  cannot bypass a check that HTTP enforces.
- Authorization is checked at the **HTTP upgrade** (a rejected socket never becomes a socket) *and again
  on every room join* (a user removed mid-session stops receiving operations immediately).

### Auth & access
- **scrypt** password hashing (N=2¹⁵), with the cost parameters stored *alongside each hash* so they can
  be raised later without invalidating anyone.
- **No user enumeration**: wrong-password and no-such-user return byte-identical responses, and a
  `fakeVerify()` equalises the *timing* (measured in CI: 178ms vs 171ms, ratio 1.04×).
- **RBAC** — Owner / Editor / Viewer. A viewer can read and cannot sync, restore, or delete.
- **A stranger gets 404, never 403** — a 403 confirms the document exists, which is an existence oracle.

### Invitations (email → accept)
Sharing a document is **not** a direct insert into the collaborators table. The owner creates a pending
`Invitation` and an email goes out (via AWS SES) with a capability-token link; access is granted only when
the invitee **accepts**.

- **Keyed by email, not user id** — the invitee may not have an account yet; existence is resolved at
  accept time, not invite time.
- **The raw token is never stored** — only its HMAC-SHA256 (keyed by the server secret, like the OTP), so
  a database dump does not yield a working invite link. 7-day expiry.
- **Accept requires the signed-in email to equal the invited email** — a forwarded link cannot grant a
  *different* account access — and the preview endpoint withholds the document title on a mismatch.
- Owner surface: create / list-pending / revoke / resend. Invitee surface: preview / accept / decline.
  Every mutation is audited, and the old *direct-add* route was removed so "no access without accept" is a
  property of the API, not a convention.

### Version history
- Immutable, git-like. **Postgres triggers reject `UPDATE` and `DELETE`** on `versions`, `operations` and
  `audit_logs` — verified by tests that go *around* the repository layer and try it from raw SQL, because
  that is the actual threat (a "quick fix" endpoint, a psql session).
- Restore is a **forward operation**, never `state = version.content` (which is whole-document
  last-write-wins and annihilates a collaborator's concurrent edits).

### AI
- Rewrite, improve, summarise, translate, grammar, tone, meeting notes, action items, continue writing,
  explain, generate title, insights — streamed over SSE.
- Powered by **DeepSeek** (OpenAI-compatible, via the `openai` SDK). The key lives **only** here and never reaches the browser.
- The document is passed to the model as **delimited data**, and model output re-enters the system as
  ordinary CRDT text operations — so it cannot inject markup or structure even if the model is fully
  compromised, and an AI rewrite merges with a collaborator's live typing like any other edit.

### Security
Every row below has a passing test.

| Threat | Defence |
|---|---|
| Massive payload / OOM | Body cap enforced **before parse** — Fastify aborts mid-stream. 1.9MB → 413. |
| Malformed JSON | 400, never a 500. |
| Replay / duplicate ops | `operationId` UNIQUE + `Idempotency-Key`; replay returns the original acks. |
| Unauthorized sync | Per-operation authorization. There is **no `findById(id)`** in the codebase — every repository method takes `(actor, …)`, so "forgot the permission check" is a compile error, not a breach. |
| SQL injection | Prisma parameterised queries. One raw statement (the advisory lock), with typed params. |
| XSS | Content is structured JSON, never HTML. Zero `dangerouslySetInnerHTML` anywhere in the system. |
| DoS | Postgres-backed sliding-window rate limiter (serverless-safe); WS flood control per socket. |
| Existence oracle | Not-a-collaborator → **404**, not 403. |
| Secrets | Never hardcoded; `.env` is `chmod 600` and gitignored. |

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node 22** | pnpm 11 requires ≥22.13 |
| Framework | **Fastify 5** | Streaming body caps *before* parse; the request lifecycle hooks (`onRequest` vs `preHandler`) are what let rate limiting run at the right point relative to auth |
| DB | **PostgreSQL 18** | Advisory locks, triggers, `LISTEN/NOTIFY` — the gapless sequence and immutable history both depend on real database features |
| ORM | **Prisma 7** + `@prisma/adapter-pg` | Parameterised by default; driver adapter means the client is portable JS/WASM with no native engine binary |
| Validation | **Zod 4** | Strict schemas — an unknown key is a **422**, never a silent ignore |
| Realtime | **ws** | A long-lived process, which is exactly why this cannot live on Vercel |
| Process mgr | **pm2** | Already supervises the neighbouring app on the box; one supervisor, one `pm2 list` that tells the truth |

---

## Project structure

Business logic never lives in a route handler.

```
src/
├── routes/          HTTP surface. Parses, delegates, serialises. No logic.
├── services/        Business logic. sync.service.ts is the commit pipeline.
├── repositories/    Data access. EVERY method takes (actor, …) — see D-011.
├── collaboration/   WebSocket relay + room hub. No write path of its own.
├── ai/              DeepSeek streaming (OpenAI-compatible) + prompts (document fenced as data).
├── middlewares/     auth, rate limiting, request size, error taxonomy
├── validators/      Zod wire schemas — the contract with the client
├── database/        Prisma client + withDocumentLock (advisory lock)
├── config/          env.ts — fails closed on a missing variable
└── constants/       limits.ts — every cap in one place
prisma/
├── schema.prisma    14 tables
└── migrations/      includes the triggers that make history immutable
scripts/
├── smoke.ts         21 checks against a RUNNING server
└── auth-smoke.ts    15 checks — incl. the timing-oracle assertion
```

ESLint enforces the layering: routes **cannot** import Prisma (`no-restricted-imports`), and `any` is a
hard error.

---

## Local setup

**Prereqs:** Node ≥22.13, pnpm 11, a local PostgreSQL. (No Docker — dev, CI and production all talk to a
real Postgres process.)

```bash
# 1. Databases
sudo -u postgres psql -c "CREATE ROLE vellum LOGIN PASSWORD 'vellum' SUPERUSER;"
sudo -u postgres psql -c "CREATE DATABASE vellum OWNER vellum;"
sudo -u postgres psql -c "CREATE DATABASE vellum_test OWNER vellum;"

# 2. Env
cp .env.example .env
#    Generate real secrets:  openssl rand -base64 48
#    API_JWT_SECRET and SERVICE_TOKEN must BYTE-MATCH the frontend's.

# 3. Install (postinstall runs `prisma generate` — the client is generated code)
pnpm install
pnpm exec prisma migrate dev

# 4. Run
pnpm dev          # :4000
```

| Command | What it does |
|---|---|
| `pnpm dev` | Watch mode |
| `pnpm test` | 66 integration tests against a **real** Postgres |
| `pnpm lint` / `pnpm typecheck` | Zero warnings, no `any` |
| `pnpm build` | `dist/` — what actually ships |
| `pnpm smoke` | 21 checks against a running server |
| `pnpm smoke:auth` | 15 auth checks (scrypt, enumeration, timing) |

Both smoke scripts accept `SMOKE_BASE_URL` and can be pointed at production:

```bash
SMOKE_BASE_URL=https://api-vellum.paperflow.in pnpm smoke
```

### Environment variables

| Key | Required | Notes |
|---|---|---|
| `DATABASE_URL` | ✅ | Postgres connection string |
| `CORS_ORIGINS` | ✅ | Comma-separated. **Never `*`** — credentials ride these requests. Plaintext `http://` is *rejected* when `NODE_ENV=production`. |
| `API_JWT_SECRET` | ✅ | ≥32 chars. Verifies the frontend's 15-minute access token. **Must byte-match the frontend.** |
| `SERVICE_TOKEN` | ✅ | ≥32 chars. Service-to-service; the frontend has no database of its own. |
| `HOST` | | `127.0.0.1` in production — nginx is the only thing that may reach the API |
| `PORT` | | 4000 |
| `DEEPSEEK_API_KEY` | | Server-side only. Blank ⇒ AI endpoints return a clear error; everything else works. |
| `DEEPSEEK_MODEL` / `DEEPSEEK_BASE_URL` | | Default `deepseek-chat` / `https://api.deepseek.com` |
| `MAX_REQUEST_BYTES`, `RATE_LIMIT_*` | | Caps; see `constants/limits.ts` |

`config/env.ts` **fails closed**: a missing or malformed variable stops the process at boot with a list of
what's wrong, rather than surfacing as a mystery 500 an hour later.

---

## Testing

```bash
pnpm test        # 66 tests, real Postgres, real advisory locks, real triggers
```

There are no database mocks. The tests that matter cannot be written against a mock:

- **Gapless sequence under 20 concurrent pushes** — a mock has no advisory locks, so it would pass while
  the real thing raced.
- **Immutable history** — the test goes *around* the repository and issues raw `UPDATE`/`DELETE`, proving
  the **database** rejects it rather than the application politely declining.
- **Authorization matrix** — 3 roles × 5 actions, plus stranger-gets-404.
- **Idempotent replay**, partial-duplicate batches, exclusive pull cursors, `410 Gone` below the
  watermark.

---

## Deployment — EC2 + pm2 + nginx

**No Docker.** The API is a Node process supervised by pm2, behind nginx, with Postgres on the same box.

### The box, and why it constrains everything

The target is a **908MB EC2 instance that already runs another production app** (`paperflow-backend`),
with nginx terminating TLS for a live vhost. Every decision below exists to stand next to that safely.

| Constraint | Consequence |
|---|---|
| 908MB RAM | **Never build on the box.** `tsc` there would put it minutes from the OOM killer — which does not know which process matters. CI builds; only `dist/` ships. |
| System Node is **20** (the neighbour's) | We run **Node 22 installed user-local via nvm**, and pm2 is given that interpreter explicitly. The system runtime is never upgraded underneath a live service. |
| nginx already serves a live vhost | We add a **new site file**. The existing one is never edited. `nginx -t` validates both before any reload. |
| pm2 supervises a neighbour | `max_memory_restart: 350M` on ours — if *we* leak, *we* get restarted, instead of the kernel picking a victim that might be theirs. |

### `fork`, not `cluster` — deliberately

The WebSocket relay keeps its document rooms **in process memory**. Cluster mode forks N workers behind a
shared socket: Alice lands on worker 1, Bob on worker 2, and they never see each other's operations over
the socket. It would *look* like it worked — HTTP sync still delivers everything, just seconds later —
which is the most expensive kind of broken. One process is the correct number until the Postgres
`LISTEN/NOTIFY` fanout exists.

### First deploy

```bash
# Postgres
sudo apt-get install -y postgresql
sudo -u postgres psql -c "CREATE ROLE vellum LOGIN PASSWORD '<generated>';"
sudo -u postgres psql -c "CREATE DATABASE vellum OWNER vellum;"

# Node 22, user-local — the system Node stays where the neighbour needs it
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. ~/.nvm/nvm.sh && nvm install 22

# Ship artifacts (built elsewhere)
rsync -az dist package.json pnpm-lock.yaml prisma prisma.config.ts ecosystem.config.cjs \
  ubuntu@HOST:/home/ubuntu/vellum-backend/

# Install, migrate, run
cd ~/vellum-backend
pnpm install --prod
pnpm exec prisma migrate deploy
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup     # survives reboot
```

> `prisma` is a **production** dependency, not a dev one — `migrate deploy` needs it *on the server*, and
> a `--prod` install that omitted it would fail there rather than on a laptop.

### nginx

A separate site file proxying to `127.0.0.1:4000`. Three lines in it are load-bearing:

- **The `Upgrade` map.** Without `proxy_set_header Upgrade`/`Connection`, the 101 never happens and the
  WebSocket silently never connects — the product keeps working (sync falls back to HTTP), so this fails
  *invisibly*.
- **`proxy_read_timeout 3600s`.** A WebSocket is idle by design; someone reading a document sends nothing
  for minutes. nginx's 60s default would guillotine it into a reconnect loop.
- **`client_max_body_size 2m`.** The API already rejects oversized bodies before parsing; nginx rejects
  them one hop earlier, so a 900MB upload never reaches Node.

```bash
sudo certbot --nginx -d api-vellum.paperflow.in    # auto-renews via systemd timer
```

---

## CI/CD

`.github/workflows/ci.yml`

```
install → prisma generate → lint → typecheck → migrate → test → build
                                                                   │
                                        (main only) rsync → pm2 reload → smoke the LIVE api
```

**Details that are not incidental:**

- **`prisma generate` runs before lint and typecheck.** The Prisma client is generated code and is
  gitignored, so on a fresh checkout it does not exist — and both the linter and compiler are type-aware.
  Without it, every repository call is "a type that cannot be resolved" and you get **438 errors**, none
  of them real.
- **Postgres comes from the runner, not a container.** GitHub's ubuntu image ships it; `systemctl start
  postgresql` is faster than pulling an image and keeps the project genuinely Docker-free.
- **Env is declared at job level**, not per step. It was per-step once, which made every new step a fresh
  chance to omit one — and the env schema fails closed, so an omission is a red build.
- **`pm2 reload`, not `restart`** — the old process gets its SIGTERM window, so in-flight requests finish
  and WebSockets close cleanly instead of being cut mid-frame on every deploy.
- **The pipeline smokes the live API after deploying.** A deploy that "succeeded" while the process
  crash-loops is not a deploy: it curls `/health`, and on failure dumps `pm2 logs` and fails the run.

### Required secrets

| Secret | Value |
|---|---|
| `DEPLOY_SSH_KEY` | Private key contents, including the `-----BEGIN/END-----` lines |
| `DEPLOY_HOST` | `13.207.4.182` |
| `DEPLOY_USER` | `ubuntu` |
| `DEPLOY_API_HOST` | `api-vellum.paperflow.in` |

### Migrations

The pipeline migrates **before** the new code starts, so the old code briefly runs against the new schema.
That is safe only for **additive** migrations. A destructive change needs expand/contract — add, backfill,
switch, drop — across two deploys. Doing it in one is how a deploy takes the API down *and* makes the
rollback fail, because the column the old code wants is already gone.

---

## Rollback

```bash
pm2 logs vellum-backend --lines 100    # what broke
pm2 restart vellum-backend             # bad process
# bad artifact: re-run the last green pipeline, or rsync the previous dist/ and `pm2 reload`
```

History in Postgres is append-only *by trigger*, so rolling back **code** can never corrupt the document
log, and a bad deploy cannot rewrite history on its way out.

---

## Further reading

`ARCHITECTURE.md` (system design, C1–C10) · `DECISIONS.md` (every trade-off, with the alternatives scored)
· `DEPLOYMENT.md` (the full runbook) · `TASKS.md` (including every bug the tests caught)
