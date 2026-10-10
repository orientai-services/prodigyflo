# SCS ⇄ ProdigyFlo Canon (DRAFT v0.1, 2026-10-09)

> Single source of truth for Solar Contract Services (SCS), ProdigyFlo (PF), and the
> Prodigy Records Service. Copies live at `docs/SCS-FLO-CANON.md` in
> `orientai-services/scs-intake`, `orientai-services/prodigyflo`, and
> `orientai-services/prodigy-records-service`. The three copies must stay
> byte-identical (`canon-check` compares the SHA in the header line below).
>
> **Change control:** nobody, human or bot, edits this file without Hector's typed
> approval on the PR (CODEOWNERS → @dakotahanshew). See §9.

Canon-Version: 0.2-draft

## How to read this
- Every rule has a stable ID: `R-<AREA>-NNN`. IDs never get reused or renumbered.
  A retired rule stays listed as `RETIRED` with the date and reason.
- **Enforcement tag** on every rule:
  - `AUTO` = `scripts/canon-check.mjs` / CI / pre-commit fails the change.
  - `TEST` = an existing unit/guard test fails it (named).
  - `BOT` = can't be checked by a script; the maintenance bots review it on every PR.
- **Evidence** cites: `MBP` = MacBook Pro evidence summary (465 requests, logs 2026-09-09 → 10-03, quoted to me in chat);
  `MINI` = devs-Mac-mini evidence in `/workspace/evidence` (23 requests, 1,686 error groups, 2026-08-05 → 10-09);
  `CHAT` = Hector's decisions in this Grok Bot thread (Oct 4–9); `CODE` = what the repos actually do today.
  "(n)" = request count in MBP's top-20 list.

Areas: `GOV` governance/ship · `SEC` secrets/safety · `SCS` SCS app · `PF` ProdigyFlo app · `REC` records service · `INT` integration contract · `DOC` documents/tiles · `MONEY` contract math · `LANG` Spanish · `COPY` client copy/compliance · `META` ads/leads · `SCOPE` off-limits systems

---

## 1. The map (what's production)

| | SCS | ProdigyFlo | Records service |
|---|---|---|---|
| Role | Homeowner marketing site + intake funnel | Staff CRM: profiles, docs, Call Center, Meta leads, calendar | Private public-records puller (deed, UCC, permit) |
| GitHub | `orientai-services/scs-intake` | `orientai-services/prodigyflo` | `orientai-services/prodigy-records-service` |
| Prod branch | `main` | `main` | `main` (runs on devs-Mac-mini, not Vercel) |
| Host | Vercel `iorient-ai/scs-intake-42` | Vercel `iorient-ai/prodigyflo-42` | devs-Mac-mini, `127.0.0.1:8787`, exposed only as `https://pull.prodigyflo.ai` (Cloudflare tunnel) |
| Domain | solarcontractservices.com | prodigyflo.ai | pull.prodigyflo.ai |
| Database | Supabase `vspmjtdwlcqfclkgksel` | Supabase `acgmcenrbwabmpxzgwqb` | none (encrypted file shelf `var/files`) |

Project IDs and forbidden sources stay in each repo's `docs/CANONICAL.md` (production map). This canon is the *behaviour* contract.

---

## 2. Governance and shipping

- **R-GOV-001** Production ships only by merging a PR into `main`; the GitHub→Vercel connection makes the one deploy. Wait for it. Never run `vercel --prod`, `vercel deploy --prod`, or a second deploy after a merge. `AUTO` (canon-check scans workflows/scripts/package.json for `--prod`). Evidence: MBP draft rule 2; MINI 6 requests + 4 error lines "Vercel env vars / deploys"; CODE PF `CLIENT-JOURNEY.md §9` "Extra Vercel deploy after merging main".
- **R-GOV-002** Nothing merges or changes production without Hector's typed go in chat ("merge it", "go"). Bots and CLIs stop at "PR open + preview proof". `BOT` (+ branch protection: required review). Evidence: MINI theme "Merge/prod change without explicit go" (3 requests, 10 error lines); repeated assistant closing "I will not merge or deploy until you ask" (MINI 10-09 rows).
- **R-GOV-003** Every change is proven on a branch preview first (screenshots, files, or test output) and the proof is posted on the PR before merge. `BOT`. Evidence: CHAT standing rule; MINI 10-04 preview-redeploy rows.
- **R-GOV-004** Commits are authored as `dakotahanshew`. `AUTO` (CI checks PR commit author/committer email/login against an allowlist). Evidence: CHAT standing rule.
- **R-GOV-005** Stage by path. Never `git add -A` / `git add .` / `git commit -a`. `AUTO` partially: pre-commit hook refuses commits that include files outside the declared task paths only if `CANON_PATHS` is set; otherwise `BOT`. Evidence: MBP draft rule 20.
- **R-GOV-006** Every step a bot or CLI hands to Hector says which machine (devs-Mac-mini / MacBook Pro / Vercel / GitHub) and who does it (Hector, Grok Build, Mac mini Ops, a bot). `BOT`. Evidence: CHAT standing rule.
- **R-GOV-007** Work only in the canonical checkout named in `docs/CANONICAL.md`; run `npm run check:canonical` before any production change. `TEST` (`scripts/check-canonical.sh`, already in PF CI). Evidence: CODE both repos; MINI 10-09 18:46 row (local path does not match the script's expected path — see Conflicts C-07).
- **R-GOV-008** No per-client branches, special cases, or homeowner names in code, docs, tests, fixtures, or branch names. `AUTO` (denylist file `canon/denylist.txt`, kept outside git history in a CI secret or maintained as hashed names) + `BOT`. Evidence: MBP (5); PF `CLIENT-JOURNEY.md §9`.
- **R-GOV-009** `AGENTS.md` is the first file every CLI agent (Grok Build, Codex, Claude Code, Cursor) reads; `CLAUDE.md` contains only `@AGENTS.md`. `AUTO` (canon-check verifies CLAUDE.md is a pointer and AGENTS.md links the canon).

## 3. Secrets and safety

- **R-SEC-001** Never print, log, paste, or commit secrets, `.env*` (except `*.example`), `.secret`, `.filekey`, `recovery-private*`, private keys, or tokens. Key *names* are fine; values never. `AUTO` (file-name + token-pattern scan). Evidence: MBP draft rule 6; MINI theme "Prod keys/secrets leaking into shells, logs, tests" (2 requests, 6 lines); MINI 10-04 17:04 row "should not take a password in this chat".
- **R-SEC-002** Never type passwords to get past a login/preview wall; production logins don't open previews. Use the protection-bypass token stored in Vercel env only. `BOT`. Evidence: MBP (5).
- **R-SEC-003** Synthetic/test clients never trigger paid public-record lookups. `TEST` (PF `isSyntheticClient` guard in `src/lib/property-records/jobs.ts`).

## 4. SCS in isolation (`scs-intake`)

- **R-SCS-001** SCS is homeowner-facing only: marketing site + intake funnel + booking (Calendly, free 25-minute review). It never stores staff CRM data and never reads PF's database. `BOT`.
- **R-SCS-002** The intake flow is **locked**. Stages: `contact, documents, reading, review, findings, money, credit, consent, booking`. Changing them, the journey docs, document classing, the uploader, `src/server/delivery/payload.ts`, or the records-analyzer files needs the commit trailer `Journey-Change-Approval: JOURNEY LOCK OPEN`, typed by Hector. `TEST` (`check:journey-lock`, `check:contact-first`, `check:eight-stage`). ⚠ Today CI checks out with depth 1, so `check:journey-lock` prints "no main base, skipped" — see Conflicts C-01; fix is in the proposed workflow.
- **R-SCS-003** Nevada only. Ads and service area: Las Vegas valley, Henderson, Boulder City. Out-of-state addresses are flagged, not served. `BOT` (+ PF test for out-of-area flag). Evidence: CHAT (5).
- **R-SCS-004** English copy masters (`src/config/copy.ts`, `marketing.ts`, `content.ts`, `scan.ts`, `chat.ts`, `qualify.ts`, `selfcheck.ts`, `privacy.ts`, `terms.ts`) change only with the commit trailer `Copy-Master-Approval: COPY MASTER OPEN`. `AUTO` (canon-check). Evidence: MBP draft rule 7 ("English copy files stay byte-for-byte").
- **R-SCS-005** Homeowners can always start a fresh intake; an old resume cookie must not block a new one (`GET /api/lead` probes, never POST). `BOT`. Evidence: MBP complaint "start a new intake without an old cookie blocking it"; SCS `CLAUDE.md` resume-cookie notes.
- **R-SCS-006** `npm run lint` in SCS has no ESLint config; never run it unattended. `BOT`. Evidence: CODE SCS `CLAUDE.md`.

## 5. ProdigyFlo in isolation (`prodigyflo`)

- **R-PF-001** PF is the staff CRM. It receives SCS data; it never writes back into SCS's database. `BOT`.
- **R-PF-002** No second OCR in PF on an SCS file (`DOCUMENT_ANALYZER` unset for SCS-owned files). SCS's Document Intelligence reading is authoritative. `TEST` (`client-journey.check.test.ts`). Evidence: PF `CLIENT-JOURNEY.md §9`; MBP draft rule 10.
- **R-PF-003** Staff signup lands in one workspace (Team Prodigy); no duplicate workspaces. `BOT` (+ `workspace:merge` script exists). Evidence: MBP complaint; existing-docs: Call Center workspace-merge fix 2026-10-03.
- **R-PF-004** Staff-verified fields (VERIFIED / CORRECTED / REJECTED) are never overwritten by a later import. `TEST` (PF intake tests). Evidence: PF `CLIENT-JOURNEY.md §6`.
- **R-PF-005** **OFF-LIMITS:** `src/app/api/admin/deploy/**` (`/api/admin/deploy`, `/ops`, `/log`, `/status`), `src/lib/deploy*`, and `deploy/` are legacy droplet tooling. Never call, run, extend, or re-enable them, and never use them as a deploy path. Production deploys only via R-GOV-001. `AUTO` (canon-check warns on any change under these paths) + `BOT`. **TODO (separate later code PR, Hector's go):** remove them. Evidence: CODE PF README "deploy/ droplet scripts are legacy"; Hector decision 2026-10-09.

## 6. Records service in isolation (`prodigy-records-service`)

- **R-REC-001** It is the only puller of public records for SCS/PF. HTTP API (from `service.py`): `GET /health`; `POST /api/service/property-records` (Bearer `RECORDS_SERVICE_KEY` or `X-Records-Secret`, header `x-analysis-case` ≥8 chars, `idempotency-key`, body `{address:{line1,city,state,postal_code}, address_version:<64-hex>}`) → `{status, parcel, outcomes[], originals[{url,sha256,mime,filename,category: deed|ucc|permit, provenance, source_url, record_key?, amendment_only?}]}`; `GET /api/service/originals/<sha256>`. 503 = county unavailable (PF retries). `TEST` (records `test_*.py`) + `BOT` for contract drift.
- **R-REC-002** It binds `127.0.0.1` only and is reachable from production only via the approved tunnel `https://pull.prodigyflo.ai`. No other tunnel (trycloudflare, ngrok, preview tunnels) in production env or code. `AUTO` (canon-check host scan) + `BOT` (Vercel env review). Evidence: CHAT resolution 1; MINI 793 tunnel/launchd error lines (uptime is the #2 error theme).
- **R-REC-003** `records.prodigyflo.ai` is the retired analyzer host and is refused by both PF (`jobs.ts`, `client.ts`) and the service (`wrong_host`). Don't reintroduce it. `TEST` (PF code guard) + `AUTO`.
- **R-REC-004** Permit routing is by parcel GIS place (Clark County `GISMO/Cities`), never the mailing city (`records/jurisdiction.py`): PLACE 0 Unincorporated Clark → Accela; 60 Henderson → EnerGov; 80 North Las Vegas → EnerGov; 65 City of Las Vegas → public ArcGIS open data + a rendered snapshot ("City of Las Vegas open data permit record (not the permit document)"); 10 Boulder City → `No permit found — no public permit search`. `records/maricopa.py` (Arizona) is kept in the repo but is **unused and not routed**: no GIS place maps to it, and the service is Nevada-only. Wiring it in is a canon change. `TEST` (`test_jurisdiction.py`, `test_permit_adapters.py`, `test_boulder_city.py`) + `BOT` (flag any import of `maricopa` from `pipeline.py`/`jurisdiction.py`). Evidence: CHAT resolution 5; Hector decision 2026-10-09; MINI 10-04 17:04 "Four of the five areas now work end to end".
- **R-REC-005** Clark UCC is pulled automatically as **one** screenshot of the newest filing by recording date. A recorder summary is labelled "County record summary (not the filing)". A missing UCC never means clear title, and the profile must never say so. `TEST` (`test_ucc_check.py`, `test_ucc_liens.py`, PF `contract.ts` labels) + `BOT` for copy. Evidence: CHAT resolution 2; MBP draft rule 12 (now superseded — see §10).
- **R-REC-006** County-site errors (Cloudflare challenges, timeouts) are transient: return 503, PF retries 2m/10m/30m/2h, max 5 attempts, then "Needs human check". No CAPTCHA bypass scripts. `TEST` (PF `jobs.ts` `MAX_ATTEMPTS`) + `BOT`. Evidence: MINI theme "County site errors / Cloudflare blocks / timeouts" — 1,639 error lines (largest theme).
- **R-REC-007** A printed search summary is never an original deed, UCC, or permit; a near-blank last deed page with an assessor watermark is the stamp, not a missing page; JBIG2/fax scans still get rasterized. `TEST` (`test_deed_pdf.py`) + `BOT`. Evidence: MBP (2)+(1); MINI theme "Deeds wrong/blank (ASSESSOR'S COPY, JBIG2)" 5 lines.
- **R-REC-008** Uptime on the mini: launchd keeps the service and `cloudflared` running; FileVault/restart must not leave the doc pull down silently. Health is `GET https://pull.prodigyflo.ai/health`. `BOT` (daily routine). Evidence: MINI 286+192+178+128… tunnel `no recent network activity` errors 10-04 → 10-09.

## 7. Integration contract (SCS ⇄ PF ⇄ Records)

| # | Trigger (where) | Transport (as found in code) | PF action | Rule |
|---|---|---|---|---|
| E1 | Homeowner clicks **NEXT on Contact** (SCS `src/app/api/step/[step]/route.ts` → `receiveLead`; `src/server/finalize.ts` enqueues `lead.received` + `kickDispatch`) | SCS delivery queue → PF `POST /api/intake/[slug]` (HMAC-signed public webhook) | Upsert Client on `scs:{leadId}`; if address has state+zip, `queuePropertyRecords` (`src/lib/intake/scs-packet.ts`) | R-INT-001 |
| E2 | PF has a PENDING `PropertyRecordsJob` | PF cron `/api/jobs/run` (every 5 min) or `POST /api/internal/records/run` (`JOBS_TOKEN`) → `RECORDS_ANALYZER_URL` = `https://pull.prodigyflo.ai/api/service/property-records` | Download each original from `/api/service/originals/<sha>` (same origin only, ≤25 MB, sha256 verified) and file it | R-INT-002, R-DOC-001 |
| E3 | Homeowner hits **Review Confirm** (SCS) | Same delivery queue → `POST /api/intake/[slug]` with full packet (`files[]` + analysis) | `processInbound` metadata only inside 20 s lock; `after()` copies files (max 5), materializes SCS analysis, upserts appointment if a clock is present | R-INT-003 |
| E4 | Calendly `invitee.created` webhook (SCS) / widget postMessage | SCS republish + `kickDispatch` | PF `parseIntakeBooking` needs `data.booking.scheduled_at` → Appointment (imported) | R-INT-004 |
| E5 | Meta Lead Ads form submit | Meta → PF `POST /api/meta/leads` (X-Hub-Signature-256) | Call Center lead only (no Client, no ignition for the SCS English Page); attribution: ad, ad set, campaign, form, platform, is_organic; out-of-area flag when state ≠ NV | R-META-001 |
| E6 | Address changes on a PF client | `queuePropertyRecords` with new `addressVersion` | Old job SUPERSEDED, old record docs EXPIRED (restored if the address returns) | R-INT-005 |
| — | PF → SCS | **None today.** PF never writes back to SCS. | — | R-INT-006 |

- **R-INT-001** Contact NEXT creates/updates the PF profile and queues the doc pull. It must not spend `lead.qualified`. `TEST` (SCS `check:contact-first` asserts `lead.received`, `kickDispatch`, "Must never use lead.qualified"). Evidence: CHAT resolution 4.
- **R-INT-002** The doc pull talks only to `pull.prodigyflo.ai` over https with Bearer auth and `idempotency-key = job.id`; retries reuse the receipt and never buy a duplicate lookup. `TEST` (PF `jobs.test.ts`).
- **R-INT-003** **Review Confirm is the full-packet push. There is no extra Send button.** Webhook stays metadata-only; file copy and materialize run in `after()`, never inside the 20 s lock. Same SCS `sourceDocumentId` never becomes a second ClientDocument. `TEST` (SCS `check:client-journey`, PF `client-journey.check.test.ts`). Evidence: MBP draft rule 3; CHAT resolution 4.
- **R-INT-004** Booking time comes from Calendly only. No time → show none. Never invent one. A sticky CONFLICT receipt must not block a later clocked packet. `TEST` (journey guards) + `BOT`. Evidence: MBP draft rule 5.
- **R-INT-005** Old-address records never satisfy the current property. `TEST` (PF `jobs.test.ts`). Evidence: MINI theme "Typo/mismatched SCS addresses → county no_match, empty record tiles" (23 lines); MINI 10-09 19:39 (address typo on a live profile).
- **R-INT-006** SCS and PF stay two repos, two databases, two Vercel projects. They talk only through E1–E4. No shared DB, no cross-repo imports. `AUTO` (canon-check: no other app's Supabase ref / DATABASE host in code) + `BOT`. Evidence: MBP draft rule 1 (top theme).
- **R-INT-007** Duplicate SCS submissions collapse onto `scs:{leadId}`; never create a second client for the same lead. `TEST` + `BOT`. Evidence: MINI theme "Duplicate SCS clients" (11 lines); MBP recurring-errors "duplicate intake submission key".

## 8. Documents and tiles

PF tiles (from `src/lib/intake/scs-document-requirements.ts`):

| SCS / records type | PF requirement key | Tile name |
|---|---|---|
| `agreement` | `solar_contract` | Solar contract or install agreement |
| `loan_or_til` | `finance_agreement` | Finance or lender agreement |
| `utility_bill` | `utility_bill` | Electric bills |
| `public_record_deed`, `public_record_property` | `property_ownership` | Home ownership documents |
| `public_record_ucc`, `public_record_lien` | `lien_filing` | UCC-1 fixture lien filing |
| `public_record_permit` | `permit_records` | County permitting records |
| `production`, `pto_letter` | `production_report`, `pto_letter` | (as named) |

- **R-DOC-001** **Exactly 3 record docs per contact address:** (1) deed → Home ownership; (2) newest UCC screenshot → UCC-1; (3) newest solar permit PDF, else permit record-page screenshot, else a status line `No permit found — <reason>` → County permitting records. Never more than one per tile per address version. `TEST` (PF `contract.test.ts` for labels) + `BOT` for the "exactly 3" count — ⚠ not found as an explicit assertion in PF code; proposed new test (see enforcement).
- **R-DOC-002** A file stays on the tile it was uploaded to; the slot wins over an AI type of "other". Never move a slotted record file to Other. Wrong tile → re-slot the same row, never copy bytes twice. `TEST` (journey guards). Evidence: MBP (9) "permit upload has to stay on the permit tile".
- **R-DOC-003** Installer agreements → `solar_contract`; lender/TIL/RIC → `finance_agreement`. Finance filenames (GoodLeap, Mosaic, Sunlight, Loanpal, TILA, promissory note, closing certificate) beat install names; an installer name is never a lender. `TEST` (SCS `check:document-class`, `check:loan-authority`; PF `scs-analysis` tests). Evidence: MBP draft rule 15; MINI 10-09 19:39 row (live finance agreement mis-slotted).
- **R-DOC-004** Every prepared page gets a JPEG (text pages 1280 px, scans 2576). `TEST` (`check:text-layer`, `check:pdf-runtime`). Evidence: MBP draft rule 11.
- **R-DOC-005** Do not invent field values (manifest id, run id, kW, remaining, first-pay, credit). Missing → "Not in paperwork". `TEST` (loan-authority) + `BOT`. Evidence: MBP (11).

## 9. Money and contract math (summary; full detail stays in `docs/CLIENT-JOURNEY.md`)

- **R-MONEY-001** A lease or PPA is not a loan. Yearly increase → `escalator_rate`, never `interest_rate`. APR only from a printed loan APR. A TIL page inside a lease stays a lease. `TEST` (`check:loan-authority`, `check:money-rates`). Evidence: MBP draft rule 4.
- **R-MONEY-002** Dealer fee = `round(0.30 × amount financed, 2)`; never OCR a dealer-fee line. kW is DC. First-pay: completion cert wins. `TEST`.
- **R-MONEY-003** Credit comes from the intake form; never OCR a credit score. `TEST`.

## 10. Spanish (language overlay)

- **R-LANG-001** Spanish is an overlay (`copy.es.ts`, `marketing.es.ts`, `scan.es.ts`, `review-fields.es.ts`) on the English masters. `scs_locale` cookie and `leads.language` store **`es`** (or `en`), never `spanish`, `es-ES`, `es-MX`. PF maps `es` only. `AUTO` (canon-check pattern) + `TEST` (`check:locale-copy`). Evidence: MBP draft rule 7 ("Map spanish to es").
- **R-LANG-002** Never translate money, percents, company names, quotes, or filenames. `BOT` (+ `check:locale-copy` where it covers it). Evidence: MBP (4).
- **R-LANG-003** Spanish TILA headings feed the same parsers; English fixtures must still pass. `TEST`.

## 11. Client copy and compliance (SoftPass never-list)

- **R-COPY-001** Client-facing copy never says guarantee, refund/money-back, cancel your contract, sue/lawsuit, fraud, predatory, names a lender or installer in a heading/CTA, or makes dollar-savings / APR-outcome claims. `TEST` (SCS `check:copy` over 3 roots incl. Spanish overlay) + `AUTO` (canon-check adds refund/sue/cancel-contract patterns if missing) + `BOT` (headings/CTA names are positional; `check-copy.ts` itself says it can't check them). Evidence: MBP (5) "Do not say guarantee"; MBP draft rule 9.
- **R-COPY-002** No guarantee or credit-protection exceptions, ever: the "Guaranteed tax credit" exception is removed (2026-10-09) and `check-copy.ts` adds credit-protection and Spanish guarantee rules. Any other addition to `APPROVED_EXCEPTIONS` or `SCOPED_RULES` is a policy change needing Hector's approval. `AUTO` (CODEOWNERS on `scripts/check-copy.ts`) + `TEST` (`check:copy`).
- **R-COPY-003** Copy may say we *extract*, never that we *conclude*. `BOT`. Evidence: SCS `CLAUDE.md`.

## 12. Meta, ads, Twilio

- **R-META-001** `/api/meta/leads` is live in PF. Leads go to the Call Center only; they do not become SCS clients and don't run ignition (SCS English Page). Each lead carries ad/ad set/campaign/form/platform/is_organic and an out-of-area flag (state ≠ NV). `TEST` (PF meta tests) + `BOT`. Evidence: CHAT resolution 3; MINI theme "Meta lead webhooks not delivered / subscription / signature" (5 lines).
- **R-META-002** Webhooks (Meta, Calendly, Twilio, anything) are registered/subscribed only when that registration is the stated task, with Hector's go. `BOT`. Evidence: MBP draft rule 17.
- **R-META-003** Meta spend is on **HOLD**. No unpausing, budget, or new campaigns without Hector's typed go. `BOT`.
- **R-META-004** Twilio texting stays **not connected**. Call Center does not create intake clients. `BOT`. Evidence: MBP draft rule 16 (Twilio part still true); MINI theme "Twilio / texting / Call Center" 220 lines.
- **R-META-005** `META_FIXTURE_LEADS=true` is preview-only, never production. `AUTO` (canon-check: not set in `vercel.json` / prod config) + `TEST` (`src/lib/meta/fixture.ts`).

## 12b. Machine outputs

- **R-GOV-014** Machine outputs never overwrite each other. MacBook Pro and devs-Mac-mini share an iCloud-synced `~/Desktop` and `~/Documents`, so every generated output folder or file (evidence pulls, reports, screenshots, logs, exports) must (a) include the machine name suffix `-macbook` or `-mini` (e.g. `~/scs-evidence-macbook/`, `~/scs-evidence-mini/`), and (b) live **outside** `~/Desktop` and `~/Documents` (e.g. `~/scs-evidence-<machine>/`, `~/Developer/_outputs-<machine>/`). Prompts to Grok Build, Mac mini Ops, or any CLI must name the path that way. `BOT` (+ `AUTO` in canon-check for repo scripts that write to `~/Desktop`/`~/Documents`). Evidence: MBP and MINI evidence both written to `~/Desktop/scs-prodigy-evidence/` on 2026-10-09; the synced copy replaced the MacBook set with the mini set (C-09).

## 13. Off-limits

- **R-SCOPE-001** Never open or change SunOff (`~/Developer/SunOffPull`) or DigitalOcean as part of SCS/PF work. `AUTO` (canon-check flags new references to `digitaloceanspaces.com` / `SunOff` in changed lines) + `BOT`. ⚠ SCS `/scan` still documents a DO Spaces dependency — see C-05.
- **R-SCOPE-002** Never deploy from, push to, or `vercel link` a forbidden source listed in `docs/CANONICAL.md`. `TEST` (`check:canonical`).

## 14. If-then quick reference

- IF Contact NEXT → THEN PF profile upsert + doc pull queued (R-INT-001).
- IF doc pull runs → THEN exactly 3 record docs filed (R-DOC-001).
- IF no permit → THEN "No permit found — <reason>" on County permitting records.
- IF City of Las Vegas → THEN ArcGIS open data + snapshot; IF Boulder City → "No permit found — no public permit search" (R-REC-004).
- IF UCC missing → THEN say "No UCC found in the county index"; NEVER "clear title" (R-REC-005).
- IF Review Confirm → THEN full packet pushed; no Send step (R-INT-003).
- IF Calendly has a time → THEN packet updated; ELSE show none (R-INT-004).
- IF Meta lead → THEN Call Center + attribution + out-of-area flag; not an SCS client (R-META-001).
- IF upload on tile X → THEN stays on X (R-DOC-002).
- IF installer agreement → solar contract tile; IF lender/TIL → finance tile (R-DOC-003).
- IF lease/PPA → escalator, not APR (R-MONEY-001).
- IF county site errors → retry with backoff, then Needs human check (R-REC-006).
- IF address changes → old records expire; new pull queued (R-INT-005).
- IF a canon/AGENTS/CLAUDE/copy-exception file changes → Hector's approval required (§15).

## 15. ALWAYS / NEVER

**ALWAYS:** ship by merging `main` and wait for its one deploy · preview proof before merge · Hector's typed go for merge/prod · commit as `dakotahanshew`, stage by path · say machine + who · store Spanish as `es` · keep money/percents/names/filenames untranslated · read `AGENTS.md` → this canon first.

**NEVER:** write machine outputs to `~/Desktop`/`~/Documents` or without a `-macbook`/`-mini` suffix · call or extend the legacy `/api/admin/deploy` / `deploy/` tooling · deploy twice / `vercel --prod` after merge · merge the two apps' repos, DBs, or Vercel projects · print/commit/log secrets or `.env` · say guarantee/refund/cancel/sue, name lenders/installers in headings, or claim dollars/APR outcomes · touch SunOff or DigitalOcean · register webhooks or connect Twilio unless that's the task · unpause/spend Meta without go · invent booking times, field values, or "clear title" · put a client's name in code/docs/tests/branches · rewrite English copy masters or the intake flow without the typed trailer · use any tunnel in prod except `pull.prodigyflo.ai`.

## 16. Change control

- **R-GOV-010** These paths are owned by `@dakotahanshew` in `CODEOWNERS` and need his approving review: `docs/SCS-FLO-CANON.md`, `docs/CANONICAL.md`, `docs/CLIENT-JOURNEY.md`, `AGENTS.md`, `CLAUDE.md`, `.github/**`, `CODEOWNERS`, `scripts/canon-check.mjs`, `scripts/check-copy.ts` (SCS), `scripts/check-journey-lock.ts` (SCS), `canon/**`. `AUTO` (CODEOWNERS + branch protection "Require review from Code Owners").
- **R-GOV-011** Bots never change canon without Hector's typed approval in chat **and** his GitHub approval. Bots may open a PR that proposes a canon change, labelled `canon-change`, with the evidence. `BOT`.
- **R-GOV-012** The three canon copies must match. `AUTO` (canon-check compares to the `Canon-Version` line and, in the overseer routine, the SHA across repos).
- **R-GOV-013** Every mistake that slips through becomes either a new `AUTO`/`TEST` check or a documented `BOT` rule within one PR. `BOT`.

## 17. Superseded older rules (from the MBP draft list)

| Old | Now | Why |
|---|---|---|
| MBP 7 / old note "prod must not point at a tunnel" | R-REC-002 | Since Oct 7 prod uses `pull.prodigyflo.ai` with Hector's go |
| MBP 12 "Clark recorder UCC is not an authorized API pull" | R-REC-005 | UCC now auto-pulled as one newest-filing screenshot |
| MBP 16 "Twilio and Meta stay disconnected" | R-META-001 / R-META-004 | Meta lead webhook live since Oct 7; Twilio still off |
| MBP 3 "Review Confirm is the push" (only trigger) | R-INT-001 + R-INT-003 | Two triggers |
| `docs/CANONICAL.md` "Records Worker … production domain is records.prodigyflo.ai" | R-REC-002/003 | That host is now refused in code |
