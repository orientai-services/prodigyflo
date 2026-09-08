# MVP_STATUS

**Application:** ProdigyFlo — Sales Client Overview
**Target workflow:** Form or Google Sheet → CRM record → email/text follow-up →
document upload → document analysis → human verification → CYS-ready data

Last updated: 2026-08-26 (deploy19, HEAD a8b3dbe)

**All P0 phases are complete and verified.** The P1 wave (messaging automation,
Phase 7 ops), the P2 AI assists, and the credential-free P3 features (client
portal, attorney workflow, RevOps analytics, Meta Ads) shipped 2026-08-25.
Still blocked/deferred: direct CYS integration (no API docs), Twilio voice,
iMessage, financing/payments, intelligent staff assignment (all credential- or
documentation-bound).

---

## Verification gate (re-run after every change)

| Gate | Command | Result |
| --- | --- | --- |
| Lint | `npx eslint src` | clean |
| Types | `npm run typecheck` | clean |
| Tests | `npm test` | **143 passing**, 8 files |
| Production build | `npm run build` | clean, **30 routes** |
| Seed | `npm run db:seed` | deterministic, synthetic |

The workflow was also driven end to end against the production build: a signed
webhook created a lead, a replay of the same payload created nothing, an upload
extracted five fields at 82–92 % confidence (all `UNVERIFIED`), the CYS tab
reported 27 % complete with missing fields named, and package generation was
refused with 409 before approval.

---

## Phase 0 — Confirm the workflow · **P0 · COMPLETE**

Documented in [`ASSUMPTIONS.md`](./ASSUMPTIONS.md).

| Question | Answer |
| --- | --- |
| Existing architecture | Next.js 16.3.2 (App Router, Turbopack), React 19, Prisma 7 + PostgreSQL, Auth.js v5, Tailwind 4 + shadcn/ui, Vitest |
| Lead & contact fields | `Client` + `ClientAddress` — name, email, phone, language, preferred contact, source/campaign/UTM, owner, region, team, value, stage |
| Lead statuses | `PipelineStage` rows (configurable per organization); mapping in ASSUMPTIONS A3 |
| Forms / Sheets in use | None pre-existing — modelled generically as `IntakeSource` |
| Field mappings | `IntakeSource.fieldMapping` JSON, edited in the UI, dot-paths supported |
| Duplicate rules | Normalised email, then phone, per organization (A8) |
| Client documents | `DocumentPackage` / `DocumentRequirement` — identity, income, contract, communication evidence, attorney-required |
| Extracted information | `DocumentExtraction` + `ExtractedField` with confidence, page, snippet, verification state (A12) |
| CYS target | The **Vercel portal** at `cancel-your-solar-iota.vercel.app/portal/dashboard` — *not* `cancelyoursolar.app`. No API; configurable field map (A5) |
| Email / SMS providers | None; labelled mock adapters behind interfaces (A6) |
| Roles & permissions | 8 `RoleKey` values, 47 permission keys, server-enforced (A15) |
| Consent | `Consent` gates outbound messaging (A11) |

Spine added: migration `p0_intake_messaging_extraction_cys` (`IntakeSource`,
`IntakeSubmission`, `MessageTemplate`, `DocumentExtraction`, `ExtractedField`,
`CysFieldDefinition`, `CysReadiness`, `CysFieldValue`, plus `PROCESSING` and
`MISSING_INFORMATION` on `DocumentStatus`), and a Vitest harness where there
were previously no tests.

## Phase 1 — Lead and contact CRM · **P0 · COMPLETE**

Lead detail page at `/clients/[clientId]` with six tabs; stage advance honouring
`allowedNextKeys` and writing `StageHistory` + audit; editable overview; merged
activity timeline from ten sources with working pagination; tasks and notes
(internal vs client-visible); manual create at `/clients/new` with duplicate
detection *before* insert; CSV import at `/clients/import` with per-column
mapping, new/duplicate/invalid classification, and idempotent re-import.
`src/lib/dedupe.ts` exposes `findDuplicates` and `mergeIncoming` — reused by
intake so both paths dedupe identically.

## Phase 2 — Forms, Sheets and webhook syncing · **P0 · COMPLETE**

`POST /api/intake/[slug]` verifies a per-source HMAC over the raw body with a
timing-safe compare. Idempotency is enforced by the unique
`(sourceId, externalId)`; a replay returns `{ duplicate: true, clientId }` and
writes no second lead, activity or audit row. Google Sheets sync runs through the
same apply pipeline behind a `SheetsProvider` interface with a deterministic mock
and a row cursor, so re-syncing is a no-op. `/settings/intake` manages sources,
mappings, dedupe order, secrets (shown once), sync history, failure filtering,
retry, and per-submission mapping repair.

## Phase 3 — Email and SMS follow-up (MVP messaging) · **P0 · COMPLETE**

Provider interfaces with labelled mock adapters (`EMAIL_PROVIDER`,
`SMS_PROVIDER`). One send path enforces permission → client scope → **consent
gate** → template render → provider → persisted `Communication`/`Message` →
audit; a `SENT` status is never recorded that the provider did not confirm.
Unresolved template placeholders block the send. 16 seeded EN/ES templates,
managed at `/settings/templates`. Composer, history, delivery/failure/pending
state and optional follow-up task live on the client's Communications tab.
Inbound sync, threads, sequences, scheduling and team inbox are **P1 and not
built**.

## Phase 4 — Document collection and analysis · **P0 · COMPLETE**

Upload validated by magic-byte sniffing (a disguised executable is rejected 422),
size and checksum; re-upload becomes version N+1 with `supersedesId`, never an
overwrite. Files are stored under opaque random keys and served only through a
permission-checked, signed, short-lived route — the directory is never static.
Extraction runs `PENDING → RUNNING → COMPLETED/FAILED` with per-type field specs,
emitting value, confidence, source page and snippet; missing required fields and
conflicts against the CRM record are computed. Side-by-side review shows the
document next to its fields with Verify / Correct / Reject, bulk-verify above 90,
and approval refused while any required field is unverified.

## Phase 5 — CYS field mapping and readiness · **P0 · COMPLETE**

Configurable field map at `/settings/cys`; resolution walks CRM, address, survey
and document sources with `verified > corrected > suggested` precedence. An
`UNVERIFIED` extracted field can only ever resolve to `SUGGESTED` — never
`VERIFIED`. Conflicts and low-confidence values are surfaced with the competing
values. Live completion percentage, readiness checklist, and an approval gate
refused **server-side** while any required field is missing, conflicting or merely
suggested. Approval advances the stage and writes `CysReadiness`; the generated
package carries per-field provenance (source, document, page, confidence,
verifier, timestamp) plus a document manifest. `/submissions` tracks status
manually — no external API is called.

## Phase 6 — Security and operational readiness · **P0 · COMPLETE**

Auth.js credentials login; server-enforced RBAC on every page, action and route
handler with `clientScope` as the single visibility rule; append-only
`AuditEvent` with redaction; signed file access; magic-byte file validation;
consent records; synthetic seed. Permission boundaries were verified at runtime
per role, including that an unauthenticated `POST /api/messages` is refused and
that out-of-scope clients are unreachable.

## Phase 3+ · Messaging automation · **P1 · COMPLETE**

Inbound webhook (HMAC on JOBS_TOKEN, idempotent, SMS STOP revokes TCPA consent),
two-way threads, scheduled sends, sequences with stage triggers + reply-stops +
consent re-checks, retries with backoff, team inbox, /api/jobs/run driven by a
5-minute systemd timer (deploy/jobs.service + .timer).

## Phase 7 · Ops improvements · **P1 · COMPLETE**

Kanban board (drag through moveClientToStage), saved filters, bulk ops with
per-row results, quick reassign, overdue/SLA alerts, four report pages, manager
performance dashboard — everything scoped through clientScope.

## AI assists · **P2 · COMPLETE**

Six provider methods on mock + Anthropic; every output is an AIRecommendation a
human accepts (→ Tasks/Notes) or dismisses. No client fields written by AI, no
credit/legal/eligibility decisions. Intelligent staff assignment deliberately
not built.

## Client portal · Attorney · RevOps · **P3 · COMPLETE (credential-free set)**

/portal (own layout, client-safe stage language, scoped uploads through the
same validation pipeline, visible-only messages with reply, appointments);
/attorney (document-gated ATTORNEY submissions with manifest); /marketing/
analytics (first/last-touch attribution, measured-probability forecast with
sample sizes, journey timing).

---

## Close-rate operating model + perspective restructure · **COMPLETE**

The three-phase close-rate playbook (35%+ ops → 60%+ path → 90% confirmation
model) is built in as a live command center, and the platform was re-sectioned
so each area owns its metrics:

- `/sales` — phase banner + the five phase metrics (close rate on qualified,
  avg AI probability on wins, monthly revenue vs target band, lead leakage,
  AI Brief adoption); `/sales/ops` — phase tracker with target-vs-actual and
  audited phase/threshold settings (org:manage); `/sales/hot-leads` — call
  queue ordered by `Client.aiCloseProbability`; `/sales/coaching` — 1-on-1s +
  scored call QA (`CoachingNote`).
- `/marketing` — overview owning every lead-gen number (leads by source and
  campaign, spend, CPL/CPQL, intake funnel); `/marketing/sources` replaces
  `/reports/sources` (redirect kept).
- `/performance` — closer scoreboard: close rate, AI probability on wins,
  brief adoption, QA average, transparent gamification points tied to AI
  accuracy (`src/lib/scoreboard.ts`).
- AI: `scoreCloseProbability` + `generateCloserBrief` on mock and Anthropic
  providers; close-probability chip + Closer Brief panel on the client page,
  `CloserBrief.viewedAt` powers adoption metrics. The score is a
  prioritization signal only — humans qualify and close.
- Engine: `src/lib/closeops.ts` (OPS_PHASES, config on
  `Organization.settings.closeOps`, `evaluatePhase`, `getHotLeads`).
- Navigation regrouped Work / Sales / Marketing / Clients / Insight / Setup;
  role homes: managers → /sales, closers → /sales/hot-leads, marketing →
  /marketing.

## Phase 2 operating-model software · **COMPLETE**

- `/sales/qualifier` — Lead Qualifier queue: human sign-off on every hot lead
  (approve / reject-with-reason), staleness when the score drifts >10 points
  or is rescored after sign-off; decisions notify the owning closer.
- `/sales/nurture` — pre-call nurture queue: upcoming appointments and hot
  leads needing a personal touch; log VIDEO/EMAIL/SMS/CALL_PREP touches,
  confirm when the client engages (`NurtureTouch`).
- Log call — first-class call logging from the client page with the 5-step
  funnel adherence checklist (`Call.adherence`); adherence feeds a scoreboard
  column and the points system. Brief-reviewed pre-checks only when the
  latest Closer Brief was actually viewed.
- AI closer assignment — `recommendCloser` surfaced on the client page:
  suggest → human accepts or overrides with a reason (`Assignment` +
  `AIRecommendation` linked); assignees get a notification.
- Job runner also freshens AI close-probability scores (unscored or >7d
  stale, capped per run, same permission gates as a human).
- Call queues (hot leads / qualifier) exclude submission-stage clients.

## Close-rate ops deepening (waves 3-7) · **COMPLETE**

Built on the Phase 1-3 operating model, all live and verified on prodigyflo.ai:

- **Daily rhythm:** `/sales/huddle` (morning huddle + end-of-day wrap,
  timezone-aware).
- **Pre-call discipline:** `/sales/qualifier` (human sign-off on every hot lead,
  drift-staleness), `/sales/nurture` (pre-call touch queue; the client opening
  the video confirms it and notifies the closer via the portal).
- **Call capture:** Log-call dialog with the 5-step funnel adherence checklist
  feeding a scoreboard column + points.
- **AI trust (keystone):** `/sales/accuracy` — reliability curve (predicted vs
  actual close rate per score bucket) on an SVG calibration diagram, Brier
  score, data-backed threshold advice, per-closer calibration; scoreboard
  gains an AI-alignment column. Outcome derived from the terminal STAGE
  (CLOSED_WON/LOST), not a Deal row, so losses are counted and the curve is
  honest.
- **Data hygiene:** `/sales/hygiene` — Phase 1 "clean data hygiene" as a scored
  checklist (unscored leads, ownerless clients, stale hot leads, past-due
  appointments, missing contact info, briefs never viewed).
- **Reach:** per-recipient scoped weekly digest (managers get team numbers,
  regionals region), notifications center (`/notifications`), full ⌘K palette
  coverage, audited CSV exports.
- **AI closer assignment** on the client page (suggest → human accepts /
  overrides). Job runner also freshens stale AI scores.
- **Quality:** committed Playwright e2e suite (42 checks, auto-covers every
  palette route); adversarial security audit found 22 real defects (server
  actions are public POST endpoints — every one now gates permissions itself),
  all fixed and verified live. 478 unit + 42 e2e green.

## Known limitations

- **Mock adapters only.** No message leaves the system; mock mode is labelled in
  the UI and never implies real delivery.
- **The CYS starter field map is an informed guess.** It has not been reconciled
  against the Vercel portal's actual intake fields. The map is data, so this is a
  Settings edit rather than a deploy — but it should be checked before first real
  use. `tests/cys-fieldmap.test.ts` guarantees every document-sourced path names
  a field the extractor actually emits, which caught one real mismatch already.
- **Image OCR is not implemented.** Text and PDF text are read for real; images
  fall back to a deterministic mock rather than pretending to have read them.
- **Local-disk document storage** in development; an S3-compatible driver is one
  implementation of `FileStorage` away.
- **Single seeded organization.** Multi-tenancy is enforced in every query and
  covered by a cross-org test, but has not been exercised in production.
- **Deferred routes are absent, not stubbed.** Navigation and `ROLE_HOME` list
  only routes that exist, so no link leads to a 404. The client portal is P3, so
  `CLIENT` accounts are told plainly they cannot use the staff app.

## Required credentials or external documentation

| Need | Blocks | Status |
| --- | --- | --- |
| CYS portal intake contract (`cancel-your-solar-iota.vercel.app`) | Reconciling the field map; direct submission (P1) | Not available — no Vercel/Supabase access is being sought |
| Email provider key (`EMAIL_PROVIDER_API_KEY`, `EMAIL_FROM`) | Real email delivery | Not available |
| Twilio SID / token / number | Real SMS delivery | Not available |
| Google service account + Sheet ID | Live Sheets sync | Not available |
| `ANTHROPIC_API_KEY` | Real document extraction (mock otherwise) | Present in `.env`; `AI_PROVIDER=mock` by default |
| S3-compatible bucket + keys | Production document storage | Not available |

---

## Running it

**Production: https://prodigyflo.ai** — DigitalOcean droplet `prodigyflo`
(64.23.190.77, sfo3, s-1vcpu-2gb + 3 GB swap, $12/mo). Domains registered
2026-08-24 via Cloudflare Registrar: prodigyflo.ai ($80/yr, 2-yr registry
minimum, canonical) and prodigyflo.com ($10.46/yr). The .com, both www hosts
and `prodigyflo.vialab.app` all 301 to the canonical .ai; TLS by Let's
Encrypt on every hostname, HTTP redirects to HTTPS. DNS is Cloudflare, DNS-only (grey
cloud), matching the ppacalculator pattern.

Server layout: app at `/opt/prodigyflo/app`, env at `/etc/prodigyflo.env`
(secrets minted on the box, never shipped), systemd unit `prodigyflo` on port
3050 behind nginx, PostgreSQL local. Redeploy = `git archive` the branch, scp
to `/opt/prodigyflo/src.tar.gz`, run `/root/deploy.sh` (idempotent).
`SHOW_DEMO_ACCOUNTS=false` hides the demo-credentials panel on the public
login page.

Deploy credentials live in `~/.config/prodigyflo/deploy.env` on this PC:
a Cloudflare token (all-zones DNS:Edit + Zone:Read) and a DigitalOcean token
(full access, **expires 2026-11-22**).

Local dev still runs on **3300** (`http://localhost:3300`, or
`Desktop\App Projects\ProdigyFlo.exe`) — port 3000 is Peptides Shop. The
temporary Tailscale Funnel on 8443 has been turned off, superseded by the
domain.

Demo sign-in: `admin@prodigyflo.ai` / `Demo!2345` (all seeded accounts share
it). ⚠ These demo credentials WORK ON THE PUBLIC SITE — the panel is hidden
but the accounts exist. Change them before showing prodigyflo.com to anyone
untrusted, or ask for a real user-management pass.
