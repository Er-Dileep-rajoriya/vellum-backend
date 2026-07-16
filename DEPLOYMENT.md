# Deployment

Two repositories, two targets, and the split is forced by one fact: **Vercel's serverless functions
cannot hold a WebSocket** (ARCHITECTURE.md C10). The relay needs a long-lived process, so it runs on a
box; the Next app is stateless, so it runs on Vercel.

```
frontend/  →  Vercel                        (Next 16 · stateless · edge-cached)
backend/   →  EC2 + pm2 + nginx + certbot   (Fastify API + WebSocket relay + Postgres 18)
```

**No Docker, anywhere.** Not in dev, not in CI, not in production. The API is a Node process supervised
by pm2 — the same supervisor already running the other app on this box, so there is one `pm2 list` that
tells the truth about the whole machine. CI runs its tests against the Postgres that ships with GitHub's
runner rather than a container.

---

## The production box

`ubuntu@13.207.4.182` — and it is **not a blank server**. It already runs `paperflow-backend` and
`paperflow-blog-worker` under pm2, with nginx terminating TLS for `api.paperflow.in`. Everything below is
written to stand next to that without disturbing it.

| Constraint | What it forced |
|---|---|
| **908MB RAM**, ~416MB free, 2GB swap | The app is **never built on the box**. `next build` / `tsc` there would put it minutes from the OOM killer — and the OOM killer does not know which process matters. CI builds; only artifacts ship. |
| System Node is **20**, pinned by paperflow | Our app runs on **Node 22 installed user-local via nvm**, and pm2 is given that interpreter explicitly. System Node is untouched, so paperflow keeps the runtime it was tested on. |
| nginx already serves a live vhost | We add a **new site file**. `api.paperflow.in` is never edited. `nginx -t` validates both before any reload. |
| pm2 already supervises two apps | `max_memory_restart: 350M` on ours. If we leak, **we** get restarted — rather than the kernel picking a victim, which might be theirs. |

### Why `fork` and not `cluster`

The WebSocket relay keeps its document rooms **in process memory**. Cluster mode would fork N workers
behind a shared socket: Alice lands on worker 1, Bob on worker 2, and they never see each other's
operations over the socket. It would *look* like it worked — HTTP sync still delivers everything, just
seconds later — which is the most expensive kind of broken. One process is the correct number until the
Postgres `LISTEN/NOTIFY` fanout in ARCHITECTURE.md §13 exists.

---

## Backend — first deploy

```bash
# 1. Postgres (on the box)
sudo apt-get install -y postgresql
sudo -u postgres psql -c "CREATE ROLE vellum LOGIN PASSWORD '<generated>';"
sudo -u postgres psql -c "CREATE DATABASE vellum OWNER vellum;"

# 2. Node 22, user-local — system Node stays on 20 for the neighbouring app
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. ~/.nvm/nvm.sh && nvm install 22

# 3. Ship artifacts (built elsewhere — never on the box)
#    dist/ package.json pnpm-lock.yaml prisma/ prisma.config.ts ecosystem.config.cjs
rsync -az dist package.json pnpm-lock.yaml prisma prisma.config.ts ecosystem.config.cjs \
  ubuntu@HOST:/home/ubuntu/vellum-backend/

# 4. Install, migrate, run
cd ~/vellum-backend
pnpm install --prod
pnpm exec prisma migrate deploy
pm2 start ecosystem.config.cjs --interpreter "$(nvm which 22)"
pm2 save && pm2 startup     # survive a reboot
```

`prisma` is a **production** dependency, not a dev one. It is needed at deploy time (`migrate deploy`),
and a `--prod` install that omits it fails on the server rather than on a laptop.

### `backend/.env` (chmod 600, never in git)

| Key | Value |
|---|---|
| `DATABASE_URL` | `postgresql://vellum:…@127.0.0.1:5432/vellum?schema=public` |
| `HOST` | `127.0.0.1` — **loopback only**. nginx is the only thing that may reach the API; binding `0.0.0.0` would publish it on the instance's public IP, TLS-less, next to the security group. |
| `PORT` | `4000` (5000 is taken by paperflow) |
| `CORS_ORIGINS` | the frontend origin, exactly. Never `*` — credentials ride these requests. |
| `API_JWT_SECRET`, `SERVICE_TOKEN` | `openssl rand -base64 48`. **Must byte-match the frontend's.** |
| `DEEPSEEK_API_KEY` | server-side only; it must never reach the browser. |

---

## nginx + TLS

A separate site file (`/etc/nginx/sites-available/api-vellum.paperflow.in`) proxying to `127.0.0.1:4000`.
Three things in it are load-bearing:

- **The `Upgrade` map.** Without `proxy_set_header Upgrade/Connection`, the 101 never happens and the
  WebSocket silently never connects. The product keeps working — sync falls back to HTTP — so this fails
  *invisibly*, which is why it is called out here.
- **`proxy_read_timeout 3600s`.** A WebSocket is idle by design; someone reading a document sends nothing
  for minutes. nginx's 60s default would guillotine it and the client would reconnect in a loop forever.
- **`client_max_body_size 2m`.** The API already rejects oversized bodies *before parsing* (D-013). nginx
  rejects them one hop earlier, so a 900MB upload never reaches Node at all.

```bash
sudo certbot --nginx -d api-vellum.paperflow.in   # renews itself via systemd timer
```

---

## Frontend — Vercel

Vercel builds from the repo. The only thing to get right is the environment, and one value is subtle:

**`NEXT_PUBLIC_API_URL` is baked in at build time**, not read at runtime. Changing it means a rebuild, not
a restart.

| Key | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `https://api-vellum.paperflow.in` | The **only** value the browser ever sees. |
| `BACKEND_URL` | `https://api-vellum.paperflow.in` | Server-side only. |
| `AUTH_SECRET` | `openssl rand -base64 32` | Auth.js session secret. |
| `API_JWT_SECRET` | *(byte-identical to the backend's)* | Mints the 15-minute access token (D-001b). |
| `SERVICE_TOKEN` | *(byte-identical to the backend's)* | Service-to-service; the frontend has no DB of its own. |
| `API_JWT_ISSUER` / `API_JWT_AUDIENCE` | `vellum-web` / `vellum-api` | |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | optional | Credentials login works without them. |

After Vercel assigns the domain, set the backend's `CORS_ORIGINS` to exactly that origin and restart it —
a mismatch here presents as "logged in, but every sync request fails", which reads like a sync bug and is
not one.

---

## CI/CD

Each repo owns its pipeline. Neither can deploy without its tests passing first.

**`backend/.github/workflows/ci.yml`** — lint → typecheck → migrate → **tests against a real Postgres**
(the gapless-sequence test pushes 20 concurrent batches and asserts no holes; a mock would assert
nothing) → build → rsync → `pm2 reload` → **smoke the live API from outside**. That last step matters: a
deploy that "succeeded" while the process crash-loops is not a deploy, so the pipeline curls `/health`
and fails, dumping `pm2 logs`, if the service does not come back.

`pm2 reload`, not `restart` — the old process gets its SIGTERM window, so in-flight requests finish and
WebSockets close cleanly instead of being cut mid-frame on every deploy.

**`frontend/.github/workflows/ci.yml`** — lint → typecheck → **CRDT convergence fuzz test** (500 histories
× 5 replicas × random delivery × duplicates) → **performance benchmark** (asserts the scaling laws, so it
fails on an algorithmic regression rather than on a busy runner) → build → Vercel.

### Required secrets

| Repo | Secret | Purpose |
|---|---|---|
| backend | `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_API_HOST` | rsync + `pm2 reload` + post-deploy health check |
| frontend | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | `vercel deploy --prebuilt --prod` |

### Migrations

The pipeline migrates **before** the new code starts, so the old code briefly runs against the new schema.
That is only safe for **additive** migrations. A destructive change needs the expand/contract dance — add,
backfill, switch, drop — across two deploys. Doing it in one is how a deploy takes the API down while the
rollback also fails, because the column the old code wants is already gone.

---

## Rollback

```bash
pm2 logs vellum-backend --lines 100     # what broke
pm2 restart vellum-backend              # if it is a bad process
# bad artifact: re-run the previous green pipeline, or rsync the previous dist/ and `pm2 reload`
```

History in Postgres is **append-only** — `versions`, `operations` and `audit_logs` reject `UPDATE` and
`DELETE` at the database level, by trigger. A rollback of the *code* can therefore never corrupt the
document log, and a bad deploy cannot rewrite history on its way out.
