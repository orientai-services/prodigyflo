# ProdigyFlo

Internal ops CRM for Solar Contract Services. Not a homeowner-facing site — that is [SCS Intake](https://github.com/lxrdgatsby/scs-intake).

**Stack:** Next.js 16 · React 19 · Prisma 7 · PostgreSQL · Auth.js · S3-compatible storage.

Read **[HANDOFF.md](./HANDOFF.md)** before changing product behavior or deploying.

## Quick start

Node **20.19+** and PostgreSQL 16. Any machine — nothing is tied to a previous laptop.

```bash
git checkout feat/schema-42-packet
cp .env.example .env
# set DATABASE_URL, AUTH_SECRET, AUTH_URL=http://localhost:3001,
#     DEMO_STAFF_PASSWORD, FILE_STORAGE_DRIVER=local  (see HANDOFF.md)
createdb prodigyflo
npm install
npx prisma generate
npm run db:migrate
npm run db:seed
npx next dev -p 3001
```

Login: `admin@prodigyflo.ai` / the `DEMO_STAFF_PASSWORD` you set. Do not use `Demo!2345`.

## Scripts

| Command | What it does |
|---|---|
| `npx next dev -p 3001` | Dev server (leave 3000 for SCS) |
| `npm run build` | Production build |
| `npm run db:migrate` | `prisma migrate deploy` |
| `npm run db:seed` | Demo org + staff + SCHEMA_42 CYS defs |
| `npm test` | Vitest (needs `DATABASE_URL`) |

## Deploy

Vercel + Supabase. Two projects, two databases. Details in `HANDOFF.md` and `deploy/README.md`. The `deploy/` droplet scripts are legacy — do not run them on Vercel.
