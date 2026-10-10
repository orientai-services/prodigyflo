<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AGENTS.md — ProdigyFlo (orientai-services/prodigyflo) (read this first, every session)

You are working in **ProdigyFlo (orientai-services/prodigyflo)**. Before you read or change anything else:

1. Read `docs/SCS-FLO-CANON.md` (the rulebook for SCS, ProdigyFlo, the records service, and how they connect). Rule IDs look like `R-INT-003`.
2. Read `docs/CANONICAL.md` (which repo / Vercel project / domain is production) and `docs/CLIENT-JOURNEY.md` (the client process).
3. Run `npm run check:canonical` and `node scripts/canon-check.mjs` before you propose a commit.

## Read-first rules (the ones that have bitten before)

- **Ship:** production = merge a PR into `main`, then wait for the one Vercel deploy. Never `vercel --prod`, never a second deploy. (R-GOV-001)
- **Go:** never merge or change production without Hector's typed go. Stop at "PR open + preview proof". (R-GOV-002, R-GOV-003)
- **Git:** commit as `dakotahanshew`. Stage by path; never `git add -A`, `git add .`, or `commit -a`. (R-GOV-004, R-GOV-005)
- **Secrets:** never print, log, or commit `.env*`, tokens, keys, `.secret`, `.filekey`, `recovery-private*`. Names only. (R-SEC-001)
- **Two apps:** SCS and ProdigyFlo stay two repos, two databases, two Vercel projects. (R-INT-006)
- **Triggers:** Contact NEXT creates the ProdigyFlo profile and queues the doc pull; Review Confirm pushes the full packet; there is no extra Send. (R-INT-001, R-INT-003)
- **Tiles:** a file stays on the tile it was uploaded to; installer agreement → solar contract tile, lender/TIL → finance tile; exactly 3 record docs per contact. (R-DOC-001..003)
- **Money:** a lease/PPA is not a loan; yearly increase is an escalator, never APR. (R-MONEY-001)
- **Booking:** time comes from Calendly; never invent one. (R-INT-004)
- **Spanish:** overlay only, stored as `es`; never translate money, percents, names, filenames. (R-LANG-001, R-LANG-002)
- **Copy:** no guarantee / refund / cancel / sue / lender or installer names in headings / dollar or APR claims. (R-COPY-001)
- **Tunnels:** production may only use `https://pull.prodigyflo.ai`. (R-REC-002)
- **Hands off:** SunOff and DigitalOcean; webhooks/Twilio unless that's the task; Meta spend is on HOLD. (R-SCOPE-001, R-META-002..004)
- **No client names** in code, docs, tests, fixtures, or branch names. (R-GOV-008)
- **Machine outputs:** never write generated files to `~/Desktop` or `~/Documents` (iCloud-synced between MacBook Pro and devs-Mac-mini); put them in e.g. `~/<name>-macbook/` or `~/<name>-mini/`. (R-GOV-014)
- **Live data:** never seed, delete, hide, reset, or rematerialize production clients/leads, or merge orgs, without Hector's typed go naming the scope. (R-GOV-015)
- **No PII:** no client names or contact info in reports, PRs, logs, tests, or folder names; use the ProdigyFlo client id. (R-SEC-004)
- **Report exactly:** after a merge, give the merge commit URL + "production Ready yes/no". Touch only the repo/files the task names. (R-GOV-016, R-GOV-017)
- **Say where and who:** every step you hand Hector names the machine and who does it. (R-GOV-006)

## ProdigyFlo-only

- No second OCR on an SCS file; SCS's reading is authoritative. (R-PF-002)
- Staff-verified fields are never overwritten by a later import. (R-PF-004)
- Meta leads go to the Call Center only, with ad/campaign attribution and an out-of-area flag. `META_FIXTURE_LEADS` is preview-only. (R-META-001, R-META-005)
- **Off-limits:** `deploy/`, `src/lib/deploy*`, and `/api/admin/deploy/**` are legacy droplet tooling. Never call, run, or extend them. Removal is a separate later PR. (R-PF-005)
- The doc pull calls `RECORDS_ANALYZER_URL` = `https://pull.prodigyflo.ai`. `records.prodigyflo.ai` stays refused. (R-REC-002, R-REC-003)
- Run `npm run typecheck && npm test` (needs `DATABASE_URL`) before proposing a PR.

## Changing the rules

`docs/SCS-FLO-CANON.md`, `docs/CANONICAL.md`, `docs/CLIENT-JOURNEY.md`, `AGENTS.md`, `CLAUDE.md`, `.github/**`, and `scripts/canon-check.mjs` are owned by @dakotahanshew (CODEOWNERS). Propose changes in a PR labelled `canon-change` with evidence. Never change them without Hector's typed approval. (R-GOV-010, R-GOV-011)

If a rule here conflicts with older docs (HANDOFF.md, STATUS.md, STAGE0-*.md, BACKLOG.md), the canon wins. Flag the conflict; don't silently "fix" either side.
