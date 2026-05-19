# Dispatch Server

> The Nightowl backend — a single-process Node server that turns GitHub issues into pull requests by shelling out to the local `claude` CLI.

Dispatch is the server half of the Nightowl project. It exposes a small Express API consumed by the [Dispatch mobile app](../dispatch-app), validates a Supabase JWT, queues up tasks against your GitHub issues, and walks each one through `planning → coding → verifying → reviewing → pushing → done` — all on whatever machine the process happens to be running on.

It is deliberately **not** a hosted multi-tenant service. Auth is multi-user, but the worker runs one task at a time per process, in the host's filesystem, using whatever `claude` credentials are installed there. Run it on your homelab, your laptop, a spare VPS — wherever you have Claude Code logged in.

---

## Features

- 🤖 **Autonomous Claude Code runs** — shells out to the local `claude` CLI in non-interactive `-p` mode, no Anthropic API key required.
- 🧭 **Phase-based state machine** — every task walks through `planning → coding → verifying → reviewing → pushing → done`, with `awaiting_input` and `failed` as graceful exits.
- 🔌 **GitHub Projects v2 integration** — sync queueable boards over GraphQL, drive task status from project columns, close issues + flip status to "Code Review" on completion.
- 🧪 **Per-repo verify hooks** — read `.dispatch.yml` from the target repo to run lint / typecheck / tests between code and review.
- 📐 **Sizer + planner + coder + reviewer** — per-phase model + thinking-effort, configurable per user via `profiles.models` JSONB.
- 🔁 **Rate-limit aware** — parses Anthropic's model-limit responses, parks the user with `anthropic_resume_after`, and resumes cleanly when the window opens.
- 🪪 **Supabase JWT auth** — every request validated, `profiles` row upserted lazily from `auth.users`.
- 🧰 **Single-flight worker** — module-level `isRunning` flag prevents concurrent tasks; primary trigger is the API, with a 2-minute `tick()` safety net.
- 🧹 **Crash-safe boot** — in-flight tasks at startup are marked `failed` with `failure_reason: 'interrupted'` so a restart never leaves orphans.

---

## Tech stack

| Layer         | Choice                                                       |
| ------------- | ------------------------------------------------------------ |
| Runtime       | Node.js (ESM, `"type": "module"`, NodeNext resolution)       |
| Language      | TypeScript 5.8                                               |
| HTTP          | Express 5                                                    |
| DB            | Postgres (Supabase) via drizzle-orm + `postgres`             |
| Migrations    | drizzle-kit                                                  |
| Auth          | Supabase JWT (`@supabase/supabase-js`)                       |
| GitHub        | `@octokit/rest` + `@octokit/graphql` (PAT)                   |
| LLM           | `claude` CLI (Claude Code), spawned per phase                |
| Logging       | pino + pino-pretty                                           |
| Validation    | zod                                                          |
| Tests         | vitest                                                       |
| Dev tunnel    | ngrok (fixed reserved domain)                                |

---

## Architecture

```
src/
├── api/              Express 5 — Supabase JWT auth, flat route mount
│   ├── auth.ts       requireAuth → upserts profiles row
│   ├── server.ts     mounts tasks / issues / settings / projects / createTask / health
│   └── routes/
├── db/               drizzle-orm schema (profiles, repos, github_projects, tasks, task_logs)
├── scheduler/        worker.ts (single-flight runner) + poller.ts (sizing + stale requeue)
├── worker/           run.ts state machine, git.ts, verify.ts, workspace.ts, cancel.ts
├── claude/           CLI client, planner, sizer, coder, reviewer
├── github/           PAT-backed Octokit, Projects v2 sync, issues, project status
├── notify/           outbound notifications
├── util/             claudeError, etc.
├── env.ts            zod-validated env; exits on failure
└── index.ts          boot — crash-safe sweep + 2-minute safety-net tick
```

### Request → task → PR flow

1. **API** validates the Supabase JWT and upserts a `profiles` row keyed by `auth.users.id`.
2. **DB** is the source of truth — tasks are enqueued with `priority`, `size`, `enqueued_at`.
3. **Scheduler** picks the next `queued` task for a user (`priority desc, size asc nulls last, enqueued_at asc`) and calls `runTask`.
4. **Worker** walks the phases, shelling out to the `claude` CLI and git inside a per-task workspace. `worker/verify.ts` runs the steps declared in the target repo's `.dispatch.yml`.
5. **`runWorkerTick`** is invoked directly by the `Start` API call; the 2-minute interval is a fallback, not the primary trigger.

---

## Getting started

### Prerequisites

- Node.js 20+
- A [Supabase](https://supabase.com) project (Postgres + Auth + GitHub OAuth on the client side)
- A GitHub Personal Access Token with `repo`, `read:org`, `project` scopes
- The `claude` CLI installed and authenticated on the host (`claude setup-token` or an interactive login under `~/.claude/`)

### 1. Clone & install

```sh
git clone https://github.com/<your-org>/dispatch-server.git
cd dispatch-server
npm install
```

### 2. Configure `.env`

Copy `.env.example` to `.env` and fill it in:

```sh
cp .env.example .env
```

Required values:

```env
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
SUPABASE_JWT_SECRET=<jwt-secret>
DATABASE_URL=postgresql://postgres:[password]@db.[ref].supabase.co:5432/postgres
GITHUB_PAT=<classic-token-with-repo-read:org-project>
PORT=3000
PUBLIC_BASE_URL=http://localhost:3000
NODE_ENV=development
```

`src/env.ts` validates the file with zod and `process.exit(1)`s on failure, so a misconfigured server fails fast at boot.

### 3. Run migrations

```sh
npm run db:push       # or: npm run db:migrate
```

### 4. Start in development

```sh
npm run dev
```

This boots an ngrok tunnel (reserved domain `nonirritably-premortuary-malisa.ngrok-free.dev`) plus `tsx watch src/index.ts`. Use the ngrok URL as the `server_url` in the mobile app's `local.properties`.

### 5. Build & start for production

```sh
npm run build
npm start
```

---

## Common commands

```sh
# Type-check (the only static check — there is no ESLint config)
npm run lint

# Run the test suite
npm test
npx vitest run test/poller.test.ts        # single file
npx vitest run -t "verify reads dispatch.yml"   # filter by name

# Drizzle
npm run db:generate    # generate migrations from src/db/schema.ts
npm run db:migrate     # apply migrations
npm run db:push        # push schema (no migration file)
npm run db:studio      # open Drizzle Studio
```

---

## Per-repo configuration: `.dispatch.yml`

Each target repo can drop a `.dispatch.yml` at its root to declare verify steps. The worker reads it during the `verifying` phase. See `src/worker/verify.ts` for the schema.

---

## Deployment

A sample systemd unit lives at `systemd/dispatch.service`. It runs as user `dispatch` from `/opt/dispatch`, loads env from `/etc/dispatch/env`, and caps memory at 900M. Adjust paths to suit your host.

---

## Architecture notes

- **ESM with NodeNext.** Local imports use `.js` extensions even though sources are `.ts` (e.g. `from './env.js'`) — don't strip them.
- **No GitHub polling.** Issues are read on-demand via Octokit; Projects v2 status is synced explicitly when needed.
- **Single-flight per process.** The worker enforces `isRunning` at module scope; horizontal scale-out is not a goal.
- **IPv4-first DNS.** `setDefaultResultOrder('ipv4first')` is intentional — Supabase's AAAA record breaks on many home networks.
- **Claude auth is the CLI's auth.** Per-phase model + thinking-effort come from `profiles.models`; the server never sees an Anthropic API key.

For the full design notes and conventions, see [`CLAUDE.md`](./CLAUDE.md).

---

## License

TBD.
