# Canonical production map

If a GitHub repo, Vercel project, domain, or local folder is **not** in this
table, do not deploy it and do not treat it as production. Run
`npm run check:canonical` from the checkout before any production change.

The two apps stay separate. Do not merge the repositories or share databases.

| | Solar Contract Services | ProdigyFlo |
|---|---|---|
| Role | Homeowner intake | Staff CRM |
| GitHub | `https://github.com/orientai-services/scs-intake` | `https://github.com/orientai-services/prodigyflo` |
| Production branch | `main` | `main` |
| Vercel team | `iorient-ai` (`team_xdz6LdIBxjAKgLKsUcIR04nh`) | same |
| Vercel project | `scs-intake-42` | `prodigyflo-42` |
| Vercel project ID | `prj_faemfrbbaFkP2ReLTyhFksFqyOnb` | `prj_SIPQJtji6NWlfyuK5l5tyvwC5GE8` |
| Public site | `https://solarcontractservices.com` | `https://prodigyflo.ai` |
| Active recovery worktree | `/Users/dakotahanshew/Documents/ChatGPT/prodigyflo/scs-e2e-01a0b8f2` | `/Users/dakotahanshew/Documents/ChatGPT/prodigyflo/implementation-01a0b8f2` |
| Database | Supabase `vspmjtdwlcqfclkgksel` (us-east-1) | Supabase `acgmcenrbwabmpxzgwqb` (us-west-2) |

`main` is the only branch that may deploy to production domains. Recovery branches may deploy protected previews with isolated databases and storage. Work on a
short-lived branch, open a pull request into `main`, and let the GitHub
connection deploy. Direct Vercel deploys are recovery-only and must be followed
by a fast-forward of `main` so GitHub and live do not drift.

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

`/Users/dakotahanshew/Developer/SCS/prodigyflo` is an empty placeholder. Until
it holds a checkout, ProdigyFlo work stays in
`/Users/dakotahanshew/Documents/ChatGPT/prodigyflo/implementation-01a0b8f2`.

## Recovery checkpoint — 2026-09-20

The active recovery branch is `codex/complete-intake-records-analyzer-01a0b8f2` in both worktrees above. The older Developer checkouts remain preserved but are stale and must not be used for this cutover. `stage0/`, assessment copies, and historical test artifacts are evidence only. The Records Worker source is captured in the SCS repository under `integrations/records/`; its production domain is `records.prodigyflo.ai`. Validate isolated acceptance before switching production readers.
