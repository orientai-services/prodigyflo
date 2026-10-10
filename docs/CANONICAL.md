# Canonical production map

If a GitHub repo, Vercel project, domain, or local folder is **not** in this
table, do not deploy it and do not treat it as production. Run
`npm run check:canonical` from the checkout before any production change.

The two apps stay separate. Do not merge the repositories or share databases.

**Rules (read first):** `docs/SCS-FLO-CANON.md`. **Client process (every homeowner):** `docs/CLIENT-JOURNEY.md`. This file is only which GitHub / Vercel / domain is production.

| | Solar Contract Services | ProdigyFlo |
|---|---|---|
| Role | Homeowner intake | Staff CRM |
| GitHub | `https://github.com/orientai-services/scs-intake` | `https://github.com/orientai-services/prodigyflo` |
| Production branch | `main` | `main` |
| Vercel team | `iorient-ai` (`team_xdz6LdIBxjAKgLKsUcIR04nh`) | same |
| Vercel project | `scs-intake-42` | `prodigyflo-42` |
| Vercel project ID | `prj_faemfrbbaFkP2ReLTyhFksFqyOnb` | `prj_SIPQJtji6NWlfyuK5l5tyvwC5GE8` |
| Public site | `https://solarcontractservices.com` | `https://prodigyflo.ai` |
| Canonical checkouts (any machine; identity = origin remote + Vercel project, checked by `npm run check:canonical`) | MacBook Pro `~/Developer/SCS/scsintake` · devs-Mac-mini `~/Developer/scs-intake` | MacBook Pro `~/Developer/products/ProdigyFlo/prodigyflo-42` · devs-Mac-mini `~/Developer/prodigyflo` |
| Records service | `orientai-services/prodigy-records-service` on devs-Mac-mini, public only as `https://pull.prodigyflo.ai` | (called by ProdigyFlo via `RECORDS_ANALYZER_URL`) |
| Database | Supabase `vspmjtdwlcqfclkgksel` (us-east-1) | Supabase `acgmcenrbwabmpxzgwqb` (us-west-2) |

`main` is the only branch that may deploy to production domains (R-GOV-001). Work on a
short-lived branch, open a pull request into `main`, show preview proof, get Hector's
typed go, and let the GitHub connection deploy. Never run `vercel --prod` and never
deploy a second time after a merge. Emergency direct deploys need Hector's typed go
in chat and must be followed by a fast-forward of `main` so GitHub and live do not drift.

## Forbidden sources

These still exist. They are not production.

**GitHub (do not push production here)**

- `lxrdgatsby/scs-intake`, `lxrdgatsby/prodigyflo`
- `Hycamax/scs-intake`, `Hycamax/prodigyflo`
- `dakotahanshew/scs-intake`

**Vercel (do not assign `solarcontractservices.com` or `prodigyflo.ai` here)**

- `gatsby-scs-intake` (`prj_uGrKYPxh5dqAar53Kh0obrGHU5QU`)
- `scs-intake` linked to `dakotahanshew/scs-intake` (`prj_0R1jPidpqrTije0ki97Ia1E4MLwu`)
- `scs-stage1` (`prj_10IVpMBiwFcxCyGmsp8g9ah0XyUw`)

**Local folders (do not `vercel link` or deploy from these)**

- `/Users/dakotahanshew/Developer/~SCS~/`
- `/Users/dakotahanshew/Developer/products/scs-intake` (Hycamax remote)
- `/Users/dakotahanshew/Developer/products/ProdigyFlo/prodigyflo` (Hycamax remote)
- `/Users/dakotahanshew/Documents/ChatGPT/prodigyflo/stage0/` — frozen evidence only. Not a checkout. Do not deploy from it.
- `/Users/dakotahanshew/Documents/ChatGPT/prodigyflo/policy-retirement/` — **does not exist.** Former extra worktrees; treat as forbidden evidence, not a checkout.

- `/Users/dakotahanshew/Documents/ChatGPT/prodigyflo/implementation-01a0b8f2`, `scs-e2e-01a0b8f2`, `assessment-*`, `recovery-private-*` — former recovery worktrees (Sept 2026). Evidence only now.
- `/Users/dakotahanshew/Developer/SCS/prodigyflo` — empty placeholder.

**Hosts**

- `records.prodigyflo.ai` — retired analyzer host. Refused by ProdigyFlo code and by the records service. Do not point anything at it.
- Any tunnel other than `https://pull.prodigyflo.ai` (trycloudflare, ngrok, preview tunnels) — not allowed in production.

## Machine outputs

MacBook Pro and devs-Mac-mini share iCloud `~/Desktop` and `~/Documents`. Generated outputs go outside both, with a `-macbook` / `-mini` suffix (R-GOV-014).

## Records path — 2026-10-07

Live ProdigyFlo pulls deed / UCC / permit through `https://pull.prodigyflo.ai` (Cloudflare tunnel to the records service on devs-Mac-mini), approved by Hector. This replaces the 2026-09-20 recovery checkpoint, which named `records.prodigyflo.ai` and the `codex/complete-intake-records-analyzer-01a0b8f2` branch; both are retired.
