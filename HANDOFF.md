# Handoff — SCS Intake + ProdigyFlo

**The table below is stale.** Production identity is
[`docs/CANONICAL.md`](docs/CANONICAL.md): GitHub
`orientai-services/scs-intake` and `orientai-services/prodigyflo`, branch
`main`, Vercel `scs-intake-42` / `prodigyflo-42`. Ignore `lxrdgatsby/*` remotes
in this file. Run `npm run check:canonical` before any production change.

These are **two separate Next.js apps**. Clone them independently. Do not merge the repos. Do not copy folders off the previous Mac — those trees have secrets, `node_modules`, and a machine-local Postgres.

**GitHub is the source of truth.** (historical table — do not follow)

| App | Repo | Branch to use | Local port |
|---|---|---|---|
| SCS Intake (homeowner funnel) | ~~https://github.com/lxrdgatsby/scs-intake~~ → `orientai-services/scs-intake` | `main` | 3000 |
| ProdigyFlo (ops CRM) | ~~https://github.com/lxrdgatsby/prodigyflo~~ → `orientai-services/prodigyflo` | `main` | 3001 |

---

## Pushed vs not-yet-pushed

If you cloned GitHub and these files exist (`vercel.json`, `src/server/pg-env.ts` / `src/lib/pg-env.ts`, `HANDOFF.md`), you have the Vercel + Supabase platform pass.

If they do **not** exist, you still have the SCHEMA_42 / FLOWS C / closer-win work. Local run is the same. Production on Vercel will need the platform pass (generic `FILE_STORAGE_*` env names, SSL for Supabase, cron routes, pool size 1). Ask for that commit to be pushed, or apply it from the other machine’s working tree — do not reconstruct it from memory.

Nothing in either app depends on `/Users/elevate`, a custom Node path, or Postgres on port `54329`.

---

## Product lock (do not “improve” these)

- SCS is the **only** front door. No second funnel, no Gatsby `/review`, no Iota `/q/`.
- Default flow is **C** (`src/steps/flows.ts` in SCS): documents before book; credit is optional prep. B is an override only (`?flow=B`).
- Stage 2 is **uploads**, not 42 homeowner questions. The 42-field schema is internal.
- Do not restyle. Do not merge the two apps.
- Ads copy in SCS `src/config/qualify.ts` is held until counsel signs.
- Never invent APR, remaining principal, payoff, or account numbers.
- A lead is a **Client**. There is no File object.
- READY is a separate gate from `CysReadiness.approvalBlockers`.
- Floor order: Grok audit packet (including closer-win brief) → stamp READY → human closer YES → then Strawberry may type Dashboard. Strawberry **never** clicks Submit (`WAIT FOR HUMAN`).
- Closer-win is an internal checklist, not homeowner legal advice.
- Keep the database **server-only**. Do not add `@supabase/supabase-js` or browser RLS.

Canonical field labels: `CYS_42_field_schema_map.csv` (copied in both repos).

---

## What you need on *your* machine

- **Node 20.19+** (`node -v`). Next 16 will not run on 18.
- **PostgreSQL 16** with `psql` / `createdb` on your PATH, *or* Docker (below).
- **npm** (comes with Node) and **git**.

That is the whole toolchain. No DigitalOcean CLI, no this-Mac Postgres, no global packages from the previous install.

Docker instead of Homebrew Postgres:

```bash
docker run --name closeos-pg -e POSTGRES_USER=scs -e POSTGRES_PASSWORD=scs \
  -p 5432:5432 -d postgres:16
docker exec -it closeos-pg createdb -U scs scs_intake
docker exec -it closeos-pg createdb -U scs prodigyflo
# then DATABASE_URL=postgresql://scs:scs@localhost:5432/<db>
```

---

## 1. SCS Intake

```bash
git clone git@github.com:lxrdgatsby/scs-intake.git
cd scs-intake
git checkout feat/schema-42-journey
cp .env.local.example .env.local
```

Edit `.env.local`:

```
DATABASE_URL=postgresql://localhost:5432/scs_intake
RESUME_TOKEN_SECRET=<openssl rand -hex 32>
NEXT_PUBLIC_FLOW_VARIANT=C
NEXT_PUBLIC_SITE_URL=http://localhost:3000
EXTRACTION_PROVIDER=mock
```

Leave object-storage keys blank for local work. Uploads go to `.uploads/` in development. In production they 501 unless `FILE_STORAGE_*` (or legacy `DO_SPACES_*`) is set — Vercel has no disk.

```bash
createdb scs_intake          # skip if the Docker block already did this
npm install
npm run migrate
npm run dev                  # http://localhost:3000  →  /begin
```

`RESUME_TOKEN_SECRET` is required. Without Resend / Slack / ProdigyFlo credentials the funnel still runs; outbound delivery logs to the console.

---

## 2. ProdigyFlo

```bash
git clone git@github.com:lxrdgatsby/prodigyflo.git
cd prodigyflo
git checkout feat/schema-42-packet
cp .env.example .env
```

Edit `.env` (local values, not the Supabase comments):

```
DATABASE_URL=postgresql://localhost:5432/prodigyflo
APP_URL=http://localhost:3001
AUTH_URL=http://localhost:3001
AUTH_TRUST_HOST=true
AUTH_SECRET=<openssl rand -base64 48>
AI_PROVIDER=mock
FILE_STORAGE_DRIVER=local
FILE_STORAGE_LOCAL_DIR=storage/documents
SHOW_DEMO_ACCOUNTS=true
DEMO_STAFF_PASSWORD=<pick a strong password; required to seed>
```

```bash
createdb prodigyflo
npm install
npx prisma generate
npm run db:migrate           # or: npx prisma migrate deploy
DEMO_STAFF_PASSWORD='…' npm run db:seed
npx next dev -p 3001         # http://localhost:3001/login
```

Seeded staff login is `admin@prodigyflo.ai` with **your** `DEMO_STAFF_PASSWORD`. The old public `Demo!2345` is refused by the seed. `SHOW_DEMO_ACCOUNTS=false` on any public host.

`npm test` is vitest. It needs `DATABASE_URL` set (the same local URL is fine).

---

## 3. Wire SCS → ProdigyFlo (optional locally)

Seed creates intake slug `scs-website` with token `local-dev-token`. That token is **dev-only**. Rotate it before production.

In SCS `.env.local`:

```
PRODIGYFLO_INTAKE_URL=http://localhost:3001/api/intake/scs-website
PRODIGYFLO_CONNECTOR_TOKEN=local-dev-token
CORS_ALLOWED_ORIGINS=http://localhost:3000
```

Finish a funnel on :3000; a Client should appear in ProdigyFlo. Dispatch is `GET/POST /api/deliveries/dispatch` (in production this is Vercel Cron + `CRON_SECRET`).

---

## 4. Vercel + Supabase (production)

Two Vercel projects, **two** Postgres databases — never one shared DB.

1. Supabase project per app (or one project with two databases — still two `DATABASE_URL`s).
2. Runtime `DATABASE_URL` = transaction pooler `:6543?sslmode=require`.
3. `DIRECT_URL` = direct host `db.<ref>.supabase.co:5432` for migrations only.
4. Run migrate **once** against `DIRECT_URL`, then deploy.
5. `FILE_STORAGE_DRIVER=s3` and `FILE_STORAGE_*` pointing at Supabase Storage’s S3 API or any S3-compatible bucket. No `UPLOAD_DIR` on Vercel.
6. `CRON_SECRET` on Vercel. `vercel.json` pings every 5 minutes (needs **Pro**; Hobby is daily). Extraction `maxDuration = 300` also needs Pro.
7. Set `AUTH_URL` / `APP_URL` / `NEXT_PUBLIC_SITE_URL` / `CORS_ALLOWED_ORIGINS` to the new hosts.
8. Keep Auth.js. Do not switch to Supabase Auth.

`deploy/` on ProdigyFlo is DigitalOcean droplet history. Do not run `provision.sh` / `deploy.sh` against Vercel.

---

## What not to commit

`.env`, `.env.local`, `.uploads/`, `storage/`, `node_modules/`, `.next/`, `.vercel/`. Templates (`.env.example`, `.env.local.example`) are the only env files in git.

---

## Stale docs

- This repo’s old `README.md` was the create-next-app stub; prefer this file and `deploy/README.md`.
- SCS `docs/BRANCHING.md` describes a `hex/*` / `dakota/*` / `integration` flow and used to name the wrong GitHub org. Current remotes are `lxrdgatsby/*`. Agree on branch policy before following it blindly.
- `MVP_STATUS.md` still mentions the old demo password and the droplet. Seed no longer accepts `Demo!2345`.
- In-app deploy console stays mock unless `/opt/prodigyflo/deploy.sh` exists (it will not on Vercel or a laptop).
