# pointless-api

Backend for **Pointless** — a points-betting web app where small private groups place virtual-points wagers on real-world propositions. Not real money, no oracle.

> **Spec is the source of truth**: [`../docs/specs/pointless.md`](../docs/specs/pointless.md). Update the spec (bump version + Change Log) before changing behavior, and reference requirement IDs (`FR-NN`, `AC-NN`, `US-NN`) in commits/PRs.

## Status

`v0.1.0` — **Phase A in progress.** Scaffold only: Express 5 + TS + Pino, healthz route, smoke tests, lint/typecheck/test wired. Mongo / Firebase Admin / Pusher / SendGrid are stubbed and come online in later phases (see spec §9).

## Stack

Node 24 · pnpm · TypeScript (ESM, NodeNext) · Express 5 · MongoDB driver v7 · Firebase Admin (Phase B) · Zod · Pino · Pusher (Phase E) · SendGrid (Phase C) · Vitest + supertest · ESLint 9 flat config · Prettier. Secrets via Infisical (Phase A-3).

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

See [`.env.example`](.env.example) for the full list. Required: `MONGO_URI`, `MONGO_DB_NAME`, `CORS_ALLOWLIST`. Required from Phase B onward: `GOOGLE_APPLICATION_CREDENTIALS`. Required from Phase E onward: `PUSHER_*`. Required from Phase C onward: `SENDGRID_*`.

## Infisical

Secrets live in [Infisical](https://infisical.com), matching `brainerd-api`'s pattern. One-time setup:

1. Install: `brew install infisical/get-cli/infisical`
2. Log in: `infisical login`
3. Create a project in the Infisical UI named `pointless-api`. Add the env vars from `.env.example` (with real values per environment).
4. From this repo: `infisical init` — creates `.infisical.json` pointing at the project + environment. (File is gitignored by Infisical convention; check your team's policy.)
5. `pnpm dev` now pulls secrets at runtime.

For CI / Docker / Heroku, use a service token: `infisical run --token $INFISICAL_TOKEN -- pnpm start`.

## Deploy (Heroku)

Heroku app: `pointless-api` (TBD — create with `heroku apps:create pointless-api` and set as the `heroku` git remote).

```bash
heroku config:set NODE_ENV=production MONGO_URI=... MONGO_DB_NAME=pointless ...   # or use infisical
pnpm publish                                                                       # = git push heroku HEAD -f
```

Heroku's Node.js buildpack auto-detects from `package.json` + `engines.node`. No `Procfile` needed — `npm start` is the default. Provision MongoDB Atlas separately and set `MONGO_URI`.

## Sibling repos

- Frontend: [`../pointless`](../pointless) — Vite + React 19 SPA.
- Reference: [`../brainerd-api`](../brainerd-api) — the older sibling backend; `pointless-api` is the first repo on the modernized stack (Zod, Vitest, Pino, ESM). `brainerd-api` will follow.
