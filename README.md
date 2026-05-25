# pointless-api

Backend for **Pointless** — a points-betting web app where small private groups place virtual-points wagers on real-world propositions. Not real money, no oracle.

> **Spec is the source of truth**: [`../docs/specs/pointless.md`](../docs/specs/pointless.md). Update the spec (bump version + Change Log) before changing behavior, and reference requirement IDs (`FR-NN`, `AC-NN`, `US-NN`) in commits/PRs.

## Status

`v0.7.0` — **Phases A through E complete; Phase F polish + READMEs done.** Live BE: Firebase Admin auth, pool/invite CRUD with FR-02 authz, full wager state machine in Mongo transactions, SendGrid email invites, Pusher realtime + notifications fan-out, channel-auth endpoint. 94 tests pass. **Pending v1**: the user's one-time Heroku app create + first deploy (F-2).

## Stack

Node 24 · pnpm · TypeScript (ESM, NodeNext) · Express 5 · MongoDB driver v7 · Firebase Admin · Zod · Pino · Pusher · SendGrid · Vitest + supertest + mongodb-memory-server (replica-set for transactions) · ESLint 9 flat config · Prettier. Secrets via Infisical for dev.

## Setup

```bash
pnpm install
cp .env.example .env.local        # then fill in values for local-only dev
pnpm dev:local                    # no infisical, uses .env.local — boots on PORT (default 5003)
```

For full secrets via Infisical, see [Infisical](#infisical) below, then `pnpm dev`. For Firebase Auth setup (required to actually hit any `/users/*` route in dev), see [Firebase setup](#firebase-setup).

## Firebase setup

Auth uses [Firebase Authentication](https://firebase.google.com/docs/auth) — client SDK on the frontend, Admin SDK here for ID-token verification. One-time setup:

1. **Create a Firebase project** (free Spark tier is fine) in the [Firebase console](https://console.firebase.google.com).
2. **Enable sign-in providers** in *Authentication → Sign-in method*: enable **Google** and **Email/Password** (turn on the **Email link (passwordless sign-in)** toggle). Add `http://localhost:5173` (and your production frontend domain) to *Authentication → Settings → Authorized domains*.
3. **Generate a service account key** in *Project settings → Service accounts → "Generate new private key"*. This downloads a JSON file — **never commit it**. Save it as `dev-admin.json` at the repo root (already gitignored via the legacy `.gitignore` pattern; double-check yours).
4. **Point env vars at it**: in `.env.local`, set `GOOGLE_APPLICATION_CREDENTIALS=./dev-admin.json`. The Firebase Admin SDK auto-reads this env var.
5. For production, store the contents of that JSON in Infisical / Heroku config under `GOOGLE_APPLICATION_CREDENTIALS` (or use a path that points at a mounted secret). Matches `brainerd-api`'s pattern.

The frontend needs the *web* Firebase config (apiKey, authDomain, projectId, appId) — these go in `pointless`'s `.env.local` and are not secret. See [`pointless` README](../pointless/README.md#firebase-setup).

## Scripts

- `pnpm dev` — `infisical run -- tsx watch src/server.ts` (requires Infisical setup)
- `pnpm dev:local` — `tsx --env-file=.env.local` (no Infisical; reads `.env.local`)
- `pnpm build` — `tsc -p tsconfig.build.json` → `dist/`
- `pnpm start` — runs `dist/server.js` (env from runtime; Heroku config or Infisical)
- `pnpm lint` / `pnpm lint:fix`
- `pnpm format` / `pnpm format:check`
- `pnpm typecheck`
- `pnpm test` / `pnpm test:watch` / `pnpm test:coverage`
- `pnpm verify` — typecheck + lint + test (run before declaring a task done)
- `pnpm publish` — `git push heroku HEAD -f` (deploy to Heroku)

## Environment

See [`.env.example`](.env.example) for the full list. Required in production:

| Var | Notes |
|---|---|
| `MONGO_URI` | MongoDB Atlas connection string (replica set for transactions) |
| `MONGO_DB_NAME` | Database name |
| `CORS_ALLOWLIST` | Comma-separated frontend origins |
| `FRONTEND_URL` | Used in invite emails |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to Firebase service-account JSON |
| `PUSHER_APP_ID` / `PUSHER_KEY` / `PUSHER_SECRET` / `PUSHER_CLUSTER` | Realtime; if any are missing the BE no-ops realtime instead of crashing |
| `SENDGRID_API_KEY` / `SENDGRID_FROM_EMAIL` | Invite emails; same graceful no-op when missing |

## Infisical

Secrets live in [Infisical](https://infisical.com), matching `brainerd-api`'s pattern. One-time setup:

1. Install: `brew install infisical/get-cli/infisical`
2. Log in: `infisical login`
3. Create a project in the Infisical UI named `pointless-api`. Add the env vars from `.env.example` (with real values per environment).
4. From this repo: `infisical init` — creates `.infisical.json` pointing at the project + environment. (File is gitignored by Infisical convention; check your team's policy.)
5. `pnpm dev` now pulls secrets at runtime.

For CI / Docker / Heroku, use a service token: `infisical run --token $INFISICAL_TOKEN -- pnpm start`.

## Deploy (Heroku)

One-time setup:

```bash
heroku apps:create pointless-api                # or your chosen name
heroku git:remote -a pointless-api               # adds the 'heroku' remote
heroku config:set \
  NODE_ENV=production \
  MONGO_URI=... \
  MONGO_DB_NAME=pointless \
  CORS_ALLOWLIST=https://your-frontend-domain \
  FRONTEND_URL=https://your-frontend-domain \
  GOOGLE_APPLICATION_CREDENTIALS=./prod-admin.json \
  PUSHER_APP_ID=... PUSHER_KEY=... PUSHER_SECRET=... PUSHER_CLUSTER=us2 \
  SENDGRID_API_KEY=... SENDGRID_FROM_EMAIL=...
```

The Firebase service-account JSON has to land on disk somewhere Heroku's slug can read. Easiest: commit a `prod-admin.json` in a private branch or use Heroku's [config-file buildpack](https://github.com/elnaposhi/heroku-buildpack-config-file) — your call.

Deploy:

```bash
pnpm publish                # = git push heroku HEAD -f
```

The included [`Procfile`](Procfile) declares `web: node dist/server.js`. Heroku's Node buildpack auto-runs `pnpm build` (pre-deploy) given `engines.node: "24"` + `packageManager: pnpm@…`. Provision MongoDB Atlas separately (free M0 tier is enough; must be a replica set so wager transactions work).

Smoke-test after first deploy: hit `https://<app>.herokuapp.com/api/v1/healthz` → `{ status: "ok", ... }`.

## Sibling repos

- Frontend: [`../pointless`](../pointless) — Vite + React 19 SPA.
- Reference: [`../brainerd-api`](../brainerd-api) — the older sibling backend; `pointless-api` is the first repo on the modernized stack (Zod, Vitest, Pino, ESM). `brainerd-api` will follow.
