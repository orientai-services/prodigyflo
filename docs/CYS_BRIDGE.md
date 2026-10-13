# CYS Bridge — ProdigyFlo Call Center ↔ SunOff (design)

Status: **design only, nothing built.** Written 2026-10-12 from read-only inspection of the repos listed in §0.
Scope approved by the owner on 2026-10-12: exactly **two** bridges between ProdigyFlo and SunOff:

1. **CYS Sign-up hand-off** (ProdigyFlo dialer lead → SunOff lead in standby → prefilled CYS sign-up).
2. **Chat** (SunOff's chat inside ProdigyFlo's dialer Messages section).

Everything else stays separate, as the 2026-10-07 rule requires: telephony, Twilio accounts and numbers, credentials, databases, the dialers' code. `docs/DIALER_APP.md`, `DIALER_POWER.md`, `DIAL_PAD.md` and `CALENDAR.md` say "nothing from any other product". The first PR of lane PF-B must add one line to each of those docs pointing here as the only approved exception.

Also in this design: the **SCS Intake** button and the **full client profile** inside the dialer lead panel. Both are ProdigyFlo-only.

---

## 0. Sources read

| System | Path | Notes |
|---|---|---|
| ProdigyFlo | `C:\Users\RZER\code\prodigyflo-orient` (main) | Next.js 16 + Prisma |
| SCS intake form | `C:\Users\RZER\code\scs-intake` (main), `scs-intake-docbrain` (branch `hex/docbrain`) | Only `hex/docbrain` emits `lead_id`, `schema_version: 'schema_42.v1'` and `data.attribution` |
| SunOff Dialer | `C:\Users\RZER\code\sunoff-leads` (+ `-b-card`, `-b-chat`) | Cloudflare Worker `sunoff-leads` |
| SunOff side of the dialer bridge | `C:\Users\RZER\sunoff_work\_dialer_bridge\` | Flask patch, migration, 53 tests |
| SunOff CYS flow | `C:\Users\RZER\sunoff_work\_rd\bilingual\live\cys_close.py` (2026-10-08) | `sunoff_live_snapshot` is from Aug 4 and stale |
| SunOff FACTS contract | `C:\Users\RZER\sunoff_work\_rd\caseintel\FACTS_SCHEMA.md` | per-lead `Lead.forms._facts` |
| SunOff chat | `C:\Users\RZER\code\sunoff-chat` (`docs/CHAT_CONTRACT.md`) | Worker `sunoff-chat`, chat.sunoff.app |

---

## A. What exists today

### A1. SunOff Dialer → SunOff app "✍️ CYS Sign up" bridge

**Dialer side (`sunoff-leads/src/close.ts`)**

| Item | Value |
|---|---|
| Browser route | `POST /api/leads/:id/close-link`, matched by `CLOSE_ROUTE` (`close.ts:17`), handled at `src/index.ts:4259-4268` → `startClose()` (`close.ts:57`) |
| Who may call it | `mayClose()` (`close.ts:30`): owner, marketer, or the lead's assigned rep |
| Upstream | `POST https://sunoff.app/api/internal/dialer-close` (`CLOSE_URL`, env override `SUNOFF_CLOSE_URL`), 10 s timeout |
| Auth | header `x-dialer-key` = secret `DIALER_CLOSE_KEY` (a shared bearer value, not an HMAC) |
| Payload | `closePayload()` (`close.ts:36`): `{dialer_lead_id, name, phone (E.164), email, address (one string), notes (≤5000), appt_at, rep:{id,name,email,phone}, source:"dialer"}` |
| Expected response | `{ok:true, url:"https://…", sunoff_lead_id, created}` |
| Write-back | migration `031_close.sql`: `leads.sunoff_lead_id`, `leads.closing_started_at` (first timestamp sticks), activity rows `close_start` / `close_error` |
| UI | `closeBtnHtml` (`public/index.html` ~3917) and `startCloseUi()` (~3937). It opens a blank tab inside the click, before the fetch, so popup blockers allow it, then navigates it to `r.url` |
| Second route | `POST /api/leads/:id/map-link` → `startOpen()` (`close.ts:98`), the same call with `purpose:"open"` |

What the dialer bridge sends today is **contact plus notes plus appointment only**. It sends no profile, no documents, no intake answers.

**SunOff side (`_dialer_bridge/server/dialer_close.py`)**

| Item | Value |
|---|---|
| Endpoint | `dialer_close()` (`:289`), registered by `init_dialer_close(app, db, ctx)` (`:108`) |
| Auth | `_key_ok()` (`:138`): `hmac.compare_digest` against `DIALER_CLOSE_KEY` from `/etc/sunoff/dialer_bridge.env`. A key shorter than 24 chars gives 503; a mismatch gives 401 plus `sec_alert`. Body limit 64 KB |
| Rep → SunOff user | `_find_user` (`:148`) checks `dialer_user_link` first, then unique email/username, then `User.card_phone` last 10 digits. No match gives 422 `no_sunoff_user` |
| Lead matching | `dialer_lead_map` first (this is what makes repeats idempotent), then `_match_in` (`:189`) by phone last 10 digits, email, street+zip, then platform-wide. A lead held by another active user gives 409 `assigned_to_other` |
| Create | `Lead` with `record_type="prospect"`, `status="new"`, `source_system="dialer"`. Existing leads only get **blank** fields filled; the original payload is kept in `forms._dialer.sent` |
| Notes / appointment | Notes deduped by sha1 into `Lead.notes` plus `LeadNote(kind="shared")`. `Appointment` of 90 min, deduped |
| Opening the lead | One-time SSO: `token_urlsafe(32)`, sha256 stored in `dialer_sso`, 10 min TTL, single use. `GET /sso/dialer` auto-POSTs so link previews can't use it up; the POST logs in and redirects to `/?lead=<id>&tab=signup` |
| Provisioning | `POST /api/internal/dialer-provision`: creates a SunOff user with an unusable password and emails a 72 h set-password link |
| Tables | `dialer_lead_map`, `dialer_sso`, `dialer_user_link` (+ DNC tables), from `migration_dnc_bridge.sql` |
| Deploy state | **Conflicting.** PROJECTS.md (10-01) says "NOT deployed". `watchdog/README_DNC.md` lists the bridge as live. The 10-11 `map-link` work assumes SunOff handles `purpose:"open"`, which no local copy does, so the live server has probably moved past these files |
| Standby | **There is no standby concept.** The lead lands as `status=new` with no CYS deal; the deal is created only when a rep taps Start |

### A2. SunOff CYS sign-up (what the prefill target looks like)

- **Where sign-up data lives:** in **CYS**, not SunOff. CYS is Supabase plus the Next.js app at `app.cancelyoursolar.com`, reached with the connected rep's own CYS login. A rep who hasn't connected gets 409 `needs_cys_connect`. SunOff keeps pointers and side data in `Lead.forms`.
- **Steps** (`BUILTIN` / `DEFAULT_ORDER`, `cys_close.py:32-55`): `rfp`, presentation (hidden), qualification (hidden), `proposal`, `total_owed`, `financing`/`iqgen` (conditional), `agreement`, `payment`, `payment_details`, `questionnaire`, `checklist`, `lpoa`, `sworn_statement`.

| CYS step | SunOff writer | Fields |
|---|---|---|
| Start / RFP | `create_lead` (`:1106`) | `customer_first_name/last_name/email/phone/address/city/state/zip`, `customer_language`, `consent=true`, `consent_at`, `status="rfp"`. Requires first name, last name and a 10-digit phone |
| Proposal | `save_proposal` (`:1191`) | `solar_installer, solar_finance_company, contract_type, solar_loan_balance, payment_method, needs_financing, finance_company, notes` |
| Total owed | `save_total_owed` (`:1229`) | `{total_owed, funds_pull_date, notes}` (must be at or above the `rep_baseline_cents` floor) |
| Questionnaire | `save_questionnaire` (`:1092`) | `{responses (q3…q41), property_address, submit:false}`, a draft the client reviews |
| Story → agreement / sworn statement | `/api/leads/<id>/cys/story` (`:3485/3493`) | `forms._cys_story {agreement, sworn}`, mirrored to `_facts.story` |
| Checklist (documents) | `_docs_auto` (~`:2252-2420`), 10-min sweep | slots `solar_contract, finance_agreement, ucc_filing, home_ownership, electric_bills, solar_production_reports, utility_interconnection, county_permitting`; deduped by sha256 in `forms._cys_docs_up` |
| Finalize | `finalize` (`:1245`) | `/api/appointment`, `/api/enroll` |

**Prefill machinery already in SunOff.** This is the key reuse point.

- **FACTS record** `Lead.forms._facts`. The schema is in §B3.4. Its single write path is `PATCH /api/leads/<id>/facts {set, source}`, in-process `case_intel.facts_patch(lead, set, source, user)`.
  - Per-field `meta.sources`.
  - `manual`/`pill`/`cys`/`records` beat `voice`/`ai`.
  - Lists only grow.
- `client()` (`:1060`) uses the lead's own columns first, then FACTS. `prefill_lead()` (`:1083`) PATCHes empty CYS columns. `_q_prefill` (`:1693`) maps FACTS to q3–q41. `POST /api/leads/<id>/cys/prefill` (`:2708`) re-applies.
- **Documents.** `client_docs/<lead_id>/<ts>_<name>` on disk, indexed in `forms._client_docs[] {category,name,fname,size,uploaded_at,src}`. Portal uploads are capped at 25 MB.

**Conclusion:** most of the "prefill every step" requirement is met once ProdigyFlo data lands in `_facts` + `_client_docs` + `_facts.story`. The new work on SunOff is the standby intake, the document pull, a `pf` source rank, and status hooks.

### A3. SunOff chat

- **What it is:** a Slack-style **internal team chat** (`sunoff-chat`, Worker `sunoff-chat`, chat.sunoff.app), **LIVE 2026-10-11** for sunoff.app and the dialer's Mensajes tab.
  - Plus **case chats**: one channel per assigned client (`auto_key case:<lead>`) that mirrors that client's SMS and can send SMS through the dialer.
  - It is not a unified inbox. Messenger and WhatsApp are not in it, although inbound WhatsApp rows get mirrored with the wrong label `via:'sms'`.
- **Identity:** canonical `uid = "u<SunOff users.id>"`. A host mints an HS256 JWT with `CHAT_SSO_SECRET`; claims `{sub,name,role,company_id,lang,host: sunoff|dialer,host_ref,iat,exp}`, ≤12 h.
  - The token is exchanged via `POST /api/session` for the HttpOnly cookie `cs`.
  - The dialer maps reps to SunOff users via `reps.sunoff_user_id`. Unlinked reps see "Vincula tu cuenta de SunOff".
- **Permissions:** `src/perm.ts`. Staff can message anyone; others reach only their downline and upline. The org tree is synced every 15 min from SunOff `/api/internal/dialer-users|dialer-teams` (`src/org.ts`).
- **Transport:** Durable Object `ChatHub` (WebSocket hibernation, one per company); falls back to polling every 5 s.
- **Data (D1):** `channels` (main / announcements / team / group / dm), `channel_members`, `messages` (threads, edits, soft delete, pins, flags, attachments, mentions, idempotent `client_id`, `ext {dir,via}`), `reactions`, `attachments` (KV), `messages_fts`, `push_subs`, `delivery`, `rooms`, `cases`, `audit`.
- **Features:**
  - Threads, reactions, edit/delete, pins, read receipts, typing, presence, unread and @mention counts, mention autocomplete.
  - Images and PDFs; voice notes with Whisper transcripts.
  - Full-text search, auto-flagging of SSNs, card numbers and profanity.
  - EN/ES UI.
  - Deep links; embed mode `?embed=sunoff|dialer` with postMessage `{sunoffChat:1,t:ready|unread|open|title|go|lang}`.
  - Google Meet "Salas".
  - Web Push, plus a fallback notify chain run by the dialer (SMS, then WhatsApp, then email).
- **Lead hooks:**
  - The chat pulls `GET dialer/api/internal/chat-cases?since=<sms id>`; the dialer pings `case-ping` when something changes.
  - Client-SMS mode calls `POST dialer/api/internal/chat-case-sms`, and the dialer sends through **its own** Twilio with `dncGuard`.
  - Internal key `CHAT_INTERNAL_KEY`.
- **Unknown:** whether Salas, cases and migrations 004/005 are deployed.

### A4. ProdigyFlo today

**Lead vs Client**

- **`CallCenterLead`** (`schema.prisma:2701`):
  - **No name, address or ZIP columns.** Name and ZIP are parsed from the FORM `CallCenterEvent.body` (`personName()` in `src/lib/call-center/from-rows.ts`).
  - Phone and email are encrypted (`phoneSecret`/`emailSecret`, `VAULT_KEY`); `phoneHash` is an HMAC with `PHONE_HASH_KEY`.
  - Consent fields `consentAt/Source/TextVersion/FormId/RevokedAt`, plus `doNotCallAt` and `intakeLinkSentAt`.
- **`CallCenterLead.clientId String?` exists, is indexed, and nothing ever writes it.** A lead and a Client are linked today only implicitly, by phone hash or name. `VoiceCall` and `MetaLeadTouch` have both ids.
- **"Send intake link"** (`sendCallCenterIntakeLink` → `sendCallCenterIntakeFor`, `src/lib/call-center/desk.ts:461`) only writes an `INTAKE_LINK` event plus `intakeLinkSentAt`. **It sends nothing and builds no URL.**

**SCS intake pipeline**

- **Receiver:** `POST /api/intake/scs-website` (`src/app/api/intake/[slug]/route.ts`).
  - Auth is `X-Connector-Token` (sha256 against `IntakeSource.secretHash`), or `X-Intake-Signature`.
  - Processed by `processInbound` (`src/lib/intake/apply.ts`) → `ingestScsPacket` (`scs-packet.ts`).
- **Matching:** `strictScs` binds only through a prior `IntakeSubmission` with the same `lead_id`, packet `id` or `portal_url`. It deliberately ignores email/phone/name, so each new SCS case becomes a new Client.
- **The SCS form (`scs-intake`):**
  - `/begin` → `WelcomeCard.start()` reads only `flow, utm_*, gclid, fbclid` into `leads.source`.
  - The packet (`buildLeadPayload`, `src/server/delivery/payload.ts`) carries `data.attribution = leads.source` **on the `hex/docbrain` branch**.
  - It has no URL prefill, no rep-assisted mode, and no partner token.
  - Delivery is queued at `lead.qualified` / `lead.booked` / `lead.updated`, 6 retries.

**Client profile (final desk)**

- `FinalDesk` (`src/components/final-desk/final-desk.tsx`, profile JSX L265–267) has these sections:
  - Header, Lead source · Meta
  - Finance agreement, Solar / intake
  - Documents (with `DocumentQuicklook`, `DocumentTileActions`, `document-download.ts`)
  - Intake answers · verbatim
  - Redline · internal posture (state, then federal)
  - Closer brief (Approve / Edit)
  - Case review PDF and Closer pitch PDF
  - Assign closer, Book, Request missing docs
- **Loaders:**
  - `loadCaseFile(user, clientId): CaseFileData` (`src/lib/daily-desk-case.ts`, type in `daily-desk-case-types.ts`)
  - `loadFinalQuestionnaire(user, clientId)` and `loadFinalDesk(user,'profile',clientId)` (`src/lib/final-desk/data.ts`)
  - `resolveCaseFacts()` (`src/lib/case-facts.ts`)
  - `assemblePacket(clientId,{persist:false})` (`src/lib/packet/data.ts`)
- **Where the data lives:**

| Data | Source |
|---|---|
| Intake verbatim | `SurveyResponse` "Client Intake Survey" → `verbatimIntake()` |
| Questionnaire | `SurveyResponse` "ProdigyFlo Final Questionnaire" v14, 42 ids `legal_name … goal` |
| Finance and solar facts | `resolveCaseFacts`: VERIFIED `CysFieldValue`, then `ExtractedField`, then intake |
| Documents | `ClientDocument` (`storageKey`, `mimeType`, `sizeBytes`, `checksum`, `version`) |
| Brief | `CloserBrief.content` (`approved` flag) |
| Redline / rights | Computed, not stored |
| Story | No testimonial model. Nearest: `CloserWinInput.painNarrative` and SCS `experience.narrative` |

- **Files:** `signedDocumentFileUrl()` returns `/api/documents/{id}/file?t=` (HMAC with `AUTH_SECRET`, 300 s). **The route also requires a session**, so it can't be used server-to-server. PDFs come from `GET /api/clients/{id}/closer-packet?kind=review|pitch`, rendered on the fly.

**Messages section**

- `MessagesSection` / `MessagesView` (`src/components/call-center/messages/*`), server code `src/lib/call-center/messages.ts`.
- Lead SMS are `CallCenterEvent` type SMS; Client SMS are `Communication` + `Message`. There is no Conversation model and no team chat.
- SMS sending is still `SMS_PROVIDER=mock` in production per PROJECTS.md.

**Access and deploy constraints**

- **Scope:** `clientScope(user)`: SUPER_ADMIN sees the whole org, CLOSER sees only owned Clients.
- **Audit:** `recordAudit(user,{action,…})` → `AuditEvent`.
- **Prior art for a JSON export:** `GET /api/cys/{clientId}/package` (`buildPackageDocument`, `src/lib/cys/package.ts`).
- **Door test:** the screen may not `fetch`, read `process.env` or import carriers (`model.test.ts`). All bridge calls must be **server actions or routes**.
- **Deploy:** PR to `orientai-services/prodigyflo` main; Vercel blocks Hector-authored commits. The apex prodigyflo.ai Worker relays only `/api/meta|telephony|inbound/`, so **SunOff must call `https://www.prodigyflo.ai/api/bridge/*`**, not the apex.

---

## B. Target design

### B1. SCS Intake button (lead → SCS form → Client → linked back)

**Button.** Label "SCS Intake", in the lead panel's **Handoff** group (`call-center.tsx` ~L904), replacing "Send intake link". Gate: the rep holds the lock (`holding(selected)`) and the lead has no `clientId` yet. Once linked, it shows "Intake linked · open profile".

**URL.** Built server-side by a server action (the door test forbids building it in the screen):

```
https://solarcontractservices.com/begin?pfl=<token>&utm_source=prodigyflo&utm_medium=call_center&utm_campaign=<pageId>&utm_content=<leadAttribution.adId|form>&fresh=1
```

- **`pfl` token** = `v1.<base64url(callCenterLeadId)>.<exp>.<hmac>`.
  - HMAC-SHA256 with a subkey derived from `AUTH_SECRET` (`HMAC(AUTH_SECRET, "pf-cc-intake-link/v1")`). **No new secret**, because only ProdigyFlo signs and verifies it; SCS passes it through as an opaque string.
  - TTL 14 days, covering clients who finish later.
- **No PII in the URL.** No name, phone or email prefill: URLs leak to logs and referrers, and SCS has no prefill-from-URL anyway. The rep reads the questions out; the homeowner types or confirms.
- **`fresh=1`** (new on SCS) makes `/begin` ignore a resume cookie. Without it, a rep's browser that started one intake would offer to resume the previous client's case.

**Delivery modes**, a split button:

1. **Open with client (live)**. Opens the URL in a new tab on the rep's screen. This is used **only to show the form while the homeowner fills it on their own device**: the rep reads the page out and the homeowner submits from their phone via "Text me this link". See decision D1.
2. **Text link**. Sends the same URL through `sendLeadText` from ProdigyFlo's own numbers. Allowed only when `consentAt` is set, `consentRevokedAt` and `doNotCallAt` are null, it's within quiet hours 9–20 lead time, and `SMS_PROVIDER` is not `mock`; otherwise the option is hidden with a reason.
3. **Copy link**.

Each mode writes an `INTAKE_LINK` event with body `{mode, tokenId}`, plus `intakeLinkSentAt`.

**SCS change (repo `scs-intake`, lane SCS-1):**

- `WelcomeCard.start()` adds `pfl` to the params it copies into `leads.source`.
- `/begin` honours `fresh=1`.
- Nothing else changes: `buildLeadPayload` already ships `leads.source` as `data.attribution`, on the `hex/docbrain` branch.
- **Prerequisite:** the live SCS deployment must be the branch that emits `lead_id` + `schema_42.v1` + `data.attribution`. Confirm before building (§E).

**ProdigyFlo receiver change (lane PF-A).** In `ingestScsPacket` (`src/lib/intake/scs-packet.ts`), after the Client is resolved:

1. Read `data.attribution.pfl`. Verify the HMAC and expiry. On failure, audit `call_center.link_rejected` and continue the intake normally; a failed link must never fail the intake.
2. Load the `CallCenterLead` by id **within the same `organizationId`** as the IntakeSource.
3. If `clientId` is null, set it. If it equals this Client, do nothing. If it is a *different* Client, keep the existing one and audit `call_center.link_conflict`.
4. Write `CallCenterEvent` type `INTAKE_LINK`, body `"linked"`, plus `recordAudit` action `call_center.lead_linked` (actor = system, `before`/`after` clientId).
5. Copy contact onto the Client only where the Client field is empty. Never overwrite intake data.

**Fallback linking (no token, e.g. a client who found SCS on their own).** When a lead panel opens and `clientId` is null, look up Clients in the org whose phone hashes to `phoneHash`, created within the last 30 days. If there's exactly one, show "Possible match: <first name> · Link". It is **never automatic**, because `strictScs` deliberately avoids identity matching. Linking requires `clients:reassign` or SUPER_ADMIN and writes the same audit row.

### B2. Full client profile inside the dialer lead panel

- **Model.** Add `clientId` and `handoff` (B3 status) to the `CallLead` view-model (`model.ts:90`), filled in `load-leads.ts` / `from-rows.ts`.
- **Component.** New `src/components/call-center/lead-profile.tsx`. It renders the **same section components** as `FinalDesk`'s profile view: Finance agreement, Solar / intake, Documents with Quicklook/upload/download, Intake answers verbatim, Questionnaire progress, Redline (state/federal), Closer brief with Approve, and the Case review / Closer pitch PDF links.
  - **Prerequisite refactor (lane PF-C):** the profile is one large JSX line in `final-desk.tsx` L265–267. Extract each section into its own named export in `src/components/final-desk/profile-sections.tsx` and make `FinalDesk` use them. **No visual change** to `/clients/[id]`; screenshot diff at 390 and 1440.
- **Data.** A server action `loadLeadProfile(leadId)`:
  1. Calls `requireUser()`.
  2. Checks the user can access this desk lead.
  3. Calls `loadCaseFile(user, clientId)` + `loadFinalQuestionnaire(user, clientId)`.
- **Scope rule.** A CLOSER only sees owned Clients. Decision, made here: a dialer user who holds the lead's lock, or is SUPER_ADMIN, gets a **read** view of the linked Client's profile through a new helper `findClientViaDeskLead(user, leadId)`.
  - **Write actions** (Approve brief, upload, request docs, Assign) still go through `requireClientInScope`, so they stay hidden for non-owners.
  - Every desk read of a profile writes `recordAudit` `client.viewed_from_desk`.
- **States without a Client:**

| Lead state | Panel shows |
|---|---|
| No intake link sent | The lead's own facts (name/ZIP from the FORM event, page, attribution, tries) + "No intake yet" + **SCS Intake** CTA |
| Link sent, not linked | "Intake link sent <ago> via <mode>", Resend / Copy, plus a Possible-match card if B1's fallback finds one |
| Linked, analysis pending | Profile skeleton + "Intake received <ago> · documents analysing" (driven by `IntakeSubmission` status) |
| Linked | Full profile + **CYS Sign up** (B3) |

- **Layout.** At ≥lg it is a second column next to the existing detail card. Below lg it is a "Profile" tab inside the lead sheet (follow `docs/MOBILE.md`: no overflow at 360/390, bottom-sheet dialogs). In the dialer the full number shows only to a Super Admin or the rep holding the lead (docs/DIALER_APP.md §Phone numbers); everyone else, and every chat and SunOff path, gets last-4.

### B3. CYS Sign up (ProdigyFlo → SunOff standby → prefilled CYS)

#### B3.1 Flow

```
Rep clicks "CYS Sign up" (lead has clientId)
  → PF server action startSunoffHandoff(leadId)
      builds payload (B3.4), revision = sha256(canonical JSON)
      upserts SunoffHandoff row (status=sending)
      POST https://sunoff.app/api/internal/pf-handoff (signed, B3.3)
  ← SunOff: matches/creates Lead, stores standby row, applies FACTS (source "pf"),
            queues document pulls, returns {ok, sunoff_lead_id, url (one-time SSO), status:"standby", created}
  → PF stores sunoff_lead_id, status=standby, opens url in the tab pre-opened inside the click
SunOff pulls each file from PF (signed GET), stores in client_docs (src="prodigyflo")
Rep (in SunOff) taps Start on the CYS tab → cys/start → create_lead() prefilled from FACTS
  → SunOff POST https://www.prodigyflo.ai/api/bridge/sunoff/status {status:"started"}
CYS finalize/enroll succeeds → status "submitted"
```

#### B3.2 ProdigyFlo pieces (lanes PF-B and PF-C)

| Piece | Where | Notes |
|---|---|---|
| Model | `prisma`: new `SunoffHandoff` | `id`, `organizationId`, `callCenterLeadId` (unique), `clientId`, `sunoffLeadId Int?`, `status` enum `SENDING\|STANDBY\|STARTED\|SUBMITTED\|WITHDRAWN\|ERROR`, `revision`, `payloadVersion`, `lastSentAt`, `startedAt`, `submittedAt`, `lastError`, `attempts`, `createdById`. Additive migration. Add `HANDOFF` to the `CallCenterEvent` type enum |
| Signing | `src/lib/sunoff-bridge/sign.ts` | B3.3, timing-safe verify |
| Payload builder | `src/lib/sunoff-bridge/payload.ts` | `buildSunoffPayload(clientId, leadId)`, which reuses `resolveCaseFacts`, `loadFinalQuestionnaire`, `verbatimIntake`, `assemblePacket({persist:false})` |
| Action | `src/lib/call-center/sunoff-actions.ts` | `startSunoffHandoff(leadId)`: requires the lock or SUPER_ADMIN plus a linked Client; 10 s timeout. `refreshSunoffHandoff(leadId)`: re-sends a newer revision |
| File route | `GET /api/bridge/sunoff/files/[handoffId]/[documentId]` | Signed request only (no session). Serves only documents listed in that handoff's manifest. Streams from storage. Audits `sunoff.file_served` |
| PDF route | `GET /api/bridge/sunoff/files/[handoffId]/packet-review` and `packet-pitch` | Renders `closer-packet` server-side (same code as `/api/clients/{id}/closer-packet`) |
| Status hook | `POST /api/bridge/sunoff/status` | Signed. Body `{pf_lead_id, sunoff_lead_id, status, at, detail?}`. Monotonic: it never moves backwards except to `WITHDRAWN`. Writes a `HANDOFF` event plus audit `sunoff.handoff_status` |
| UI | `call-center.tsx` Handoff group | "✍️ CYS Sign up" → once sent: "In SunOff · Standby", "Started", "Submitted", each opening SunOff; "Re-send profile" when the Client changed after `lastSentAt` |

**Idempotency.** `pf_lead_id = "pf:<organizationId>:<callCenterLeadId>"` is SunOff's map key, the counterpart of `dialer_lead_id`. Every request carries `Idempotency-Key: <handoffId>:<revision>`. SunOff applies an unchanged revision as a no-op that still returns a fresh SSO `url`.

**Retries.** The click path is synchronous. On a network or 5xx failure the row goes to `ERROR` and the rep sees "SunOff didn't answer · Retry". There are no silent background retries for the first send, because the rep is waiting for the tab. Re-sends after profile changes are queued on the existing `/api/jobs/run` cron: backoff 1, 5 and 30 min, then 2 h, at most 6 tries, and only while status is `STANDBY`.

**Opening SunOff.** Same as the dialer: open a blank tab inside the click handler, then set `location` to the returned one-time `url`. On phones use the same tab.

#### B3.3 Auth: one new shared secret

**`PF_SUNOFF_BRIDGE_KEY`**: 32+ random bytes, base64. It is stored in Vercel `prodigyflo-42` production env and in SunOff `/etc/sunoff/pf_bridge.env`. It is separate from `DIALER_CLOSE_KEY` so either can be rotated or revoked alone.

Both directions sign every request, so it isn't a bearer value:

```
X-PF-Bridge-Ts:  <unix seconds>
X-PF-Bridge-Sig: v1=<hex HMAC_SHA256(key, ts + "\n" + METHOD + "\n" + path + "\n" + sha256hex(body))>
Idempotency-Key: <handoffId>:<revision>          (POSTs only)
```

- A request with skew over 300 s is rejected.
- `Idempotency-Key` values are kept 24 h for replay rejection: SunOff in table `pf_bridge_nonce`, ProdigyFlo in the `SunoffHandoff` row.
- SunOff applies the same `sec_alert` thresholds as `_key_ok`.

#### B3.4 Payload `pf-handoff/v1` (field map)

```jsonc
{
  "version": "pf-handoff/v1",
  "pf_lead_id": "pf:<org>:<ccLeadId>",
  "pf_client_id": "<Client.id>",
  "revision": "<sha256>",
  "purpose": "handoff",            // or "open" (no data change, just SSO)
  "rep": { "pf_user_id", "name", "email" },          // email = mapping key, no phone
  "contact": { ... }, "facts": { "<dotted.path>": {"v": ..., "src": "pf|pf_verified"} },
  "intake_verbatim": [{ "q", "a" }],
  "questionnaire": { "version": 14, "status", "current_step", "answers": { "<pf id>": ... } },
  "story": { ... }, "dates": { ... }, "appointment": { ... },
  "documents": [ ... ], "internal": { ... }, "consent": { ... }, "attribution": { ... }
}
```

Body cap 512 KB. **Files never travel inline.**

**`contact` → SunOff `Lead` columns and `_facts.client`**

| PF source | Payload | SunOff target |
|---|---|---|
| `Client.firstName/lastName` | `contact.first`, `contact.last` | `Lead.first_name/last_name`, `client.first/last` |
| `Client.email` | `contact.email` | `Lead.email`, `client.email` |
| `Client.phone` (E.164) | `contact.phone` | `Lead.phone`, `client.phone`. **Full phone crosses here only**, because CYS `create_lead` needs 10 digits |
| `ClientAddress` primary | `contact.address{line1,line2,city,state,zip}` | `Lead.address/city/state/zip`, `client.address…` |
| `Client.preferredLanguage` | `contact.language` (`en\|es`) | `client.language` → CYS `customer_language` |

**`facts`: from `resolveCaseFacts` (+ extraction).** The source is `pf_verified` when the fact came from a VERIFIED/CORRECTED `CysFieldValue` or a verified `ExtractedField`, otherwise `pf`.

| PF fact | FACTS path | Feeds CYS step |
|---|---|---|
| product (loan/ppa/lease/cash) | `finance.contract_type` | proposal `contract_type` |
| lender / financier | `finance.finance_company` | proposal `solar_finance_company` |
| installer | `system.installer` | proposal `solar_installer` |
| amount financed / remaining balance | `finance.balance` (dollars) | proposal `solar_loan_balance`, total_owed suggestion |
| APR | `finance.apr` | questionnaire |
| escalator % | `finance.escalator_pct` | q25 |
| term (months ÷ 12) | `finance.term_years` | q24 |
| monthly payment | `finance.monthly` | q23 |
| system kW | `system.size_kw` | — |
| in-service / first-pay year | `system.install_year` | — |
| payments made / interest paid | `finance.payments_made` | — |
| UCC (records) | `finance.ucc_filed` | q36 |
| permit no. (records) | `system.permit_no` | — |
| utility name / account (`ExtractedField`) | `facts["utility.name"]`, `facts["utility.account"]` | new FACTS keys, used by checklist notes only |

**`questionnaire` (PF Final Questionnaire v14 → FACTS → CYS q-ids)**

The PF v14 questions follow the CYS questionnaire order 1:1. SunOff applies them through FACTS so `_q_prefill` keeps working unchanged. Option labels are mapped to the FACTS enums by an **explicit table in `payload.ts`, tested against SunOff's `q_fields.json`**; an unmapped label is sent as `*_other` text, never guessed.

| PF id | FACTS path | | PF id | FACTS path |
|---|---|---|---|---|
| legal_name | client.first/last (split) | | untrue | issue.promises[] (free text, q22) |
| prop_addr | client.address/city/state/zip | | mo_pay | finance.monthly |
| mail_same | (No → client.mailing_address required) | | term_yrs | finance.term_years |
| phone / email | client.phone / client.email | | escalator | finance.escalator_pct |
| sole_owner | client.sole_owner | | combo_bill | issue.bill_change |
| on_contract | client.contract_names | | told_lower | issue.told_bill_lower |
| prop_type | client.property_type | | working | system.producing |
| sales_co | system.sales_company | | perf | issue.performance[] |
| install_co | system.installer | | install | issue.install_problems[] |
| lender | finance.finance_company | | service | issue.service_problems[] |
| agree_type | finance.contract_type (first; all kept in `answers`) | | oob | system.installer_status (verify wording) |
| year_signed | sale.signed_year | | complaints | issue.complaints_filed[] |
| sign_where | sale.signed_where | | selling | issue.selling_home |
| notice_3day | sale.three_day_notice | | sale_issue | issue.sale_blocked |
| got_copies | sale.got_copies | | ucc | finance.ucc_filed |
| first_contact | sale.first_contact | | age | client.age_band / client.age |
| pres_where | sale.presentation_where | | le | client.language_barrier (verify wording) |
| pres_len | sale.presentation_length | | credit_ck | sale.credit_check |
| pressure | sale.tactics[] | | hardship | issue.hardship[] |
| promises | issue.promised[] | | goal | issue.outcome_wanted[] |
| misled | issue.misled | | | |

The raw `answers` also travel, stored in `forms._pf.questionnaire`, so nothing is lost if a mapping is wrong.

**The other payload blocks**

| Block | PF source | SunOff target |
|---|---|---|
| `intake_verbatim[]` | `verbatimIntake()` (SCS Client Intake Survey, provenance kept) | `forms._pf.intake_verbatim`; shown read-only in the SunOff lead's Docs tab. Not pushed to CYS |
| `story.transcript` | SCS `experience.narrative` (homeowner's own words) + `CloserWinInput.painNarrative` | `_facts.story.transcript` (source `pf`), `story.transcript_lang`. SunOff's existing story tool composes `agreement`/`sworn` from it; the rep approves |
| `story.testimonial` | **Doesn't exist in PF** | sent as `null`. SunOff's story tool produces the testimonial |
| `issue` | SCS `experience.flags/theories/urgency` | `issue.main_issue`, `issue.reasons` (only taxonomy codes SunOff knows; others go in `forms._pf.flags`) |
| `dates` | `Contract.signedAt`, first-pay, in-service, `IntakeSubmission.receivedAt`, `CallCenterLead.createdAt` (FB form), `consentAt` | `forms._pf.dates`; `sale.signed_year` from `signedAt` |
| `appointment` | next `Appointment.startsAt` / `endsAt` / type | SunOff `Appointment` (90 min, deduped as in `dialer_close`) |
| `documents[]` | `ClientDocument` (latest version per requirement) | `{id, file_name, mime, size, sha256 (=checksum), category, cys_slot, url: "/api/bridge/sunoff/files/<handoffId>/<docId>"}`. SunOff pulls with a signed GET, stores in `client_docs/<lead_id>/` with `src="prodigyflo"`, indexes in `_client_docs`. `_docs_auto` pushes to the CYS checklist after Start (sha256 dedupe already exists). Files over 25 MB are skipped with a reason |
| `internal` | Closer brief (`CloserBrief.content` + `approved`), redline `rights.state/federal`, case review PDF, closer pitch PDF (as `documents` entries with `category:"pf_internal"`) | `forms._pf.internal`. **Visible to SunOff reps only; never sent to the CYS checklist, client portal or story** |
| `consent` | `consentAt`, `consentSource`, `consentTextVersion`, revoked/DNC flags | `forms._pf.consent`. Informational only. **SunOff must not use it to set CYS `consent=true`** (see §C) |
| `attribution` | `leadAttribution` (ad / adset / campaign / form) | `forms._pf.attribution` |

**Document categories → CYS slots** (from `ClientDocument.requirement` / `DocumentExtraction.detectedTypeKey`):

| CYS slot | PF document types |
|---|---|
| `solar_contract` | solar agreement / PPA / lease / purchase contract |
| `finance_agreement` | loan agreement / TILA disclosure / loan statement |
| `ucc_filing` | UCC-1 / lien filing |
| `home_ownership` | deed / assessor record |
| `electric_bills` | utility bill |
| `solar_production_reports` | production / monitoring report |
| `utility_interconnection` | interconnection / PTO letter |
| `county_permitting` | permit |
| `pf_internal` | case review PDF, closer pitch PDF (never pushed to CYS) |
| `other` | everything else (kept in SunOff, not pushed) |

#### B3.5 SunOff pieces (lane S-1, built next to `_dialer_bridge`)

| Piece | Spec |
|---|---|
| Endpoint | `POST /api/internal/pf-handoff` in new `server/pf_handoff.py`, registered like `init_dialer_close`. Reuses `parse_address`, `_match_in`, `_pick`, the appointment and notes helpers, and the SSO minting from `dialer_close.py`. Factor shared helpers into `bridge_common.py` without changing `dialer_close` behaviour (its 53 tests must stay green). nginx exact-match location as in `deploy.sh` |
| Rep → SunOff user | New table `pf_user_link(pf_user_id PK, sunoff_user_id, linked_ts, source)`. Lookup: link row first, then unique email. No match gives 422 `no_sunoff_user` with a message the PF UI shows ("Ask the owner to link your SunOff account"). An optional `POST /api/internal/pf-provision` mirrors `dialer-provision` (decision D2) |
| Standby table | `pf_handoff(pf_lead_id PK, sunoff_lead_id, pf_client_id, org_id, revision, payload jsonb, status standby\|started\|submitted\|withdrawn, received_ts, started_ts, submitted_ts, last_error)` + `pf_bridge_nonce(key PK, ts)` + `pf_sso` (same shape as `dialer_sso`) |
| On accept | Match or create `Lead` (`source_system="prodigyflo"`, `record_type="prospect"`, `status="new"`). Write `forms._pf = {pf_lead_id, pf_client_id, revision, received_at, intake_verbatim, questionnaire, internal, consent, attribution, dates}`. Then `facts_patch(lead, facts, source="pf"\|"pf_verified")`, enqueue document pulls, upsert the appointment, `LeadNote` "Received from ProdigyFlo (rev …)", `audit("pf_handoff")`, `log_activity`. **No CYS/Supabase call.** That is the standby |
| FACTS source ranks | Add `pf` (overwrites empty/`ai`/`voice` only) and `pf_verified` (ranked with `records`). Neither ever overwrites `manual`/`pill`/`cys`. Change in `case_intel.facts_patch` source table |
| Document puller | Background job (reuse the 10-min sweep cron slot): signed GET for each manifest entry, sha256 check, write to `client_docs`, append to `_client_docs`. Retry 3× then mark `skipped:<reason>` in `forms._pf.docs_status` |
| Prefill hooks | See table below |
| Status emitter | `pf_status(lead, status, detail)` → signed `POST https://www.prodigyflo.ai/api/bridge/sunoff/status`, fire-and-forget with 3 retries. Called after `cys/start` succeeds (`started`), after `finalize`/`enroll` succeed (`submitted`), and when the lead is closed-lost or deleted in SunOff (`withdrawn`) |
| Response | `{ok, sunoff_lead_id, created, matched_by, status, url:"https://sunoff.app/sso/pf?t=<token>", expires_in:600}`; `/sso/pf` behaves exactly like `/sso/dialer` → `/?lead=<id>&tab=signup` |
| UI badge | The SunOff lead header shows "From ProdigyFlo · standby" with the PF internal brief / PDFs in the Docs tab (rep-only) |

**Prefill hooks per CYS step**

| CYS step | Prefill source | Change needed |
|---|---|---|
| Start / RFP | `client()` → `_facts.client` | None. It already falls back to FACTS. Lead columns are filled on accept |
| Proposal | `finance.contract_type`, `finance.finance_company`, `system.installer`, `finance.balance` | **Verify** the proposal form reads FACTS; if not, read them as defaults (`payment_method` stays a rep choice) |
| Total owed | `finance.balance` | Show as a suggestion only; the rep confirms against the payoff letter |
| Questionnaire | `_q_prefill` (q3–q41 from FACTS) | None, provided §B3.4's enum map is right |
| Agreement / sworn statement | `_facts.story` | None. The story tool composes from `story.transcript` |
| Checklist | `_client_docs` via `_docs_auto` | Exclude `category=pf_internal` and `other` from auto-push |
| Payment / payment_details / lpoa | — | **No prefill.** Client-performed; never automate |

### B4. Chat

**Recommendation: do not build a second chat and sync it.** Two-way sync of two chat systems is unsound. Edits, soft deletes, reactions, pins, read receipts, threads and voice transcripts would each need conflict rules. Identities and the permission tree (SunOff's upline/downline from `org.ts`) don't exist in ProdigyFlo. Every message would have two ids and two moderation queues.

**Design: ProdigyFlo becomes a third host of the one SunOff chat**, exactly as the SunOff Dialer is ("the same way").

| Dialer mechanism | ProdigyFlo equivalent |
|---|---|
| Rep → SunOff user (`reps.sunoff_user_id`) | `pf_user_link` from B3.5, shared. Unlinked PF users see "Link your SunOff account" |
| `GET /api/chat/token` mints JWT with `CHAT_SSO_SECRET` | `GET /api/chat/token` in PF (route, `requireUser`) mints a JWT signed with **`PF_CHAT_KEY`** (kid `pf`), `host:"prodigyflo"`, `sub: u<sunoff_user_id>`, ≤12 h. The chat Worker verifies kid `pf` with that key and **ignores role/staff/super claims from the PF token**: role comes from SunOff's org sync for that uid |
| Embedded in Mensajes tab via `?embed=dialer` | **As built (D4): native, no iframe.** Messages opens on **Team chat** (switch "Team chat \| Leads (SMS)"). `src/components/call-center/messages/chat/` is a client of the chat Worker's REST + WebSocket API: `GET /api/chat/token` → `POST <chat>/api/session {token}` → a **bearer** session held in memory (no cookie: Safari blocks third-party cookies), socket via a one-use `POST /api/ws-ticket`, files fetched with the bearer as blob URLs. The shell seam replaces postMessage with window events (`messages/chat/host-bus.ts`): `pfchat:unread` → Messages badge + `(n)` title, `pfchat:title` → phone top bar, `pfchat:go` ← push taps; deep links `#c=`, `#m=`, `#thread=`, `#case=<lead id>` (docs/TEAM_CHAT_PARITY.md) |
| Case chats from dialer leads (`chat-cases` feed, `case-ping`) | **PF case chats:** the chat pulls `GET https://www.prodigyflo.ai/api/bridge/chat/cases?since=<cursor>` (signed with `PF_CHAT_KEY`), returning PF desk leads that have a linked SunOff user as rep, with stage, appt, phone4 and SMS rows from `CallCenterEvent` type SMS. PF pings `POST chat/api/internal/pf/case-ping` on inbound SMS / reassignment. Channel `auto_key case:pf:<ccLeadId>`, so it can never collide with `case:<dialer lead>` |
| Client-SMS mode → `chat-case-sms` → dialer Twilio | For `case:pf:*` channels, the chat calls **`POST https://www.prodigyflo.ai/api/bridge/chat/case-sms`** `{pf_lead_id, uid, pf_user_id, body, request_id}` (signed). `pf_user_id` is the PF token's `host_ref`; PF checks it really links to `uid` (forward lookup through `pf_user_link`), then lock (or Super Admin) / consent / DNC / mock / quiet hours, sends through **ProdigyFlo's Twilio subaccount**, records `CallCenterEvent` SMS and returns `{ok, id, via:'sms', delivery}`; a repeated `request_id` answers `duplicate:true` and never sends twice. The chat stores `client_id "pf:<id>"` for dedupe. **The chat Worker never holds PF Twilio credentials and never routes a PF lead to the SunOff dialer** |
| Push relay `chat-push` to dialer devices | The chat's own VAPID Web Push, subscribed from ProdigyFlo: push-only `public/chat-sw.js` (scope `/chat-sw/`, controls no page), `POST <chat>/api/push/subscribe {subscription, host:'prodigyflo'}`; taps open `https://www.prodigyflo.ai/call-center?s=messages#c=<ch>` or route an open Call Center in place. Switch: Team chat › 🔔 Notifications (`push-toggle.tsx`). No PF push relay |
| Fallback notify via dialer (SMS/WA/email) | **Not through SunOff.** For PF-only people the chat calls signed **`POST /api/bridge/chat/notify`** `{uid, pf_user_id, title, body, url, count}`; PF re-checks the link and sends one email from its own mail path (≤140-char summary, link kept on www.prodigyflo.ai), at most one per person per 3 h, audited `chat.fallback_notice`; answers `{ok:true, sent}` |

**Features PF users get** (all of them, since it is the same app): channels / DMs / groups, threads, reactions, edit/delete, pins, read receipts, typing, presence, unread and mention badges, @mentions, images/PDF, voice notes plus transcripts, search, moderation flags, EN/ES, deep links, Salas (Meet), case chats with Team/Client-SMS composer modes.

**Chat Worker changes (lane S-2):**

- `src/jwt.ts`: multi-key verify (kid), host `prodigyflo`.
- `api.ts postSession`: never `super`/`staff` from a PF token.
- CORS adds `https://www.prodigyflo.ai` (no `frame-ancestors` change: no iframe).
- New `src/pfcases.ts`: feed pull + `case-sms` router chosen by `auto_key` prefix.
- `POST /api/internal/pf/case-ping`.
- Fix the hardcoded `via:'sms'` while there.

**PF changes (lane PF-D):**

- `src/app/api/chat/{token,unread}/route.ts`
- `src/lib/chat-bridge/{jwt,link,cases,sms,notify,remote,sign}.ts`
- `src/app/api/bridge/chat/{cases,case-sms,notify}/route.ts`
- Native Team chat `src/components/call-center/messages/chat/**` (no iframe, no CSP `frame-src`); shell seam `use-chat-host.ts`; `public/chat-sw.js`

**Which PF leads get case chats:** only desk leads whose current lock holder or Client owner has a `pf_user_link`. Members are that rep plus PF SUPER_ADMINs who are linked (mentions-only). Phone stays last-4 in the chat (`cases.phone4`).

**Built (owner decision D4):** the native ProdigyFlo-styled client of the chat Worker's existing REST + WebSocket API, with a bearer session from the same `/api/session` (not a cookie). Same data, no second store, no sync. Feature parity with SunOff Chat is tracked row by row in docs/TEAM_CHAT_PARITY.md.

---

## C. Security and compliance

**PII in transit**

- Only TLS server-to-server: Vercel ↔ the sunoff.app droplet behind nginx.
- Full phone and email cross **only** in the CYS hand-off body (CYS needs them). The chat carries last-4 only.
- No PII in URLs: the intake token is an opaque lead id plus HMAC; SSO tokens are random and single-use.

**Keys** (least privilege, one per bridge, each revocable alone)

| Name | Holders | Allows |
|---|---|---|
| `PF_SUNOFF_BRIDGE_KEY` | PF (Vercel env), SunOff (`/etc/sunoff/pf_bridge.env`) | `pf-handoff`, PF file pulls for listed docs, status hook. Nothing else |
| `PF_CHAT_KEY` | PF (Vercel env), chat Worker secret | Minting PF-host chat sessions (no elevated role), the PF case feed, case-sms, case-ping |
| (derived) intake-link subkey of `AUTH_SECRET` | PF only | Signing `pfl` tokens |

**Must never cross**

- Twilio credentials, numbers, TwiML apps or webhooks, in either direction.
- `DIALER_CLOSE_KEY`, `CHAT_SSO_SECRET`, `CHAT_INTERNAL_KEY`, `VAULT_KEY`, `PHONE_HASH_KEY`, `AUTH_SECRET`, DB URLs, Meta tokens.
- SunOff dialer leads into PF, or PF leads into the SunOff dialer.
- The SunOff dialer's fallback SMS to PF staff.
- PF `internal` content (redline posture, closer pitch, rights analysis) into anything client-facing: the CYS checklist, client portal or story.

**Audit**

| Side | Events |
|---|---|
| PF (`recordAudit` / `AuditEvent`) | `call_center.lead_linked`, `call_center.link_rejected`, `call_center.link_conflict`, `client.viewed_from_desk`, `sunoff.handoff_sent` (revision, doc count, no field values), `sunoff.handoff_status`, `sunoff.file_served` (doc id, bytes), `chat.token_issued`, `chat.case_sms_sent` |
| SunOff | `audit("pf_handoff")`, `audit("pf_doc_pulled")`, `log_activity` on the Lead, `pf_sso` used rows, `sec_alert` on bad signatures |
| Chat | Its existing `audit` table gets `session.pf`, `case_sms.pf` |

**Consent, TCPA and texting**

- Every text to a PF lead, including from the chat's Client-SMS mode, leaves from PF's subaccount after PF's own checks: `consentAt` present and not revoked, `doNotCallAt` null, 9–20 lead-local time, NV NRS 598.0918 hours, and the same quiet-hours rule as `DIALER_POWER.md`.
- Texting stays disabled while `SMS_PROVIDER=mock` or until the subaccount's A2P campaign is approved (status unknown, §E).
- **CYS consent:** SunOff's `create_lead` writes `consent=true` / `consent_at`. A PF hand-off **must not** satisfy that by itself: the homeowner's CYS consent / e-sign / LPOA / sworn statement / payment steps stay client-performed in SunOff's flow. Prefill fills **drafts** only. The questionnaire already saves with `submit:false`.
- **Recording and rep-assisted intake:** SCS's `call_recording` consent is required in all-party states. A rep filling SCS for a homeowner would record consents from the rep's browser. That is why B1 has the homeowner submit from their own device (decision D1).

**Cross-entity data sharing.** ProdigyFlo LLC (three members, repo owned by OrientAI) would send client PII to SunOff. This needs partner sign-off and privacy-policy coverage for both the SCS consent text and the ProdigyFlo policy (decision D3).

---

## D. Lanes for parallel builders

Files don't overlap between lanes. `call-center.tsx` is owned by **PF-C only**: the other PF lanes export server actions and model fields that PF-C wires in. The `messages` teammate currently working on the Messages section must coordinate with PF-D on `messages-section.tsx`; PF-D adds only a switch plus a new `team-chat.tsx`.

| Lane | Repo | Owns (files) | Acceptance checks |
|---|---|---|---|
| **PF-A Link** | prodigyflo-orient | `src/lib/call-center/intake-link.ts` (token sign/verify, URL builder), `src/lib/call-center/desk.ts` (`sendCallCenterIntakeFor` → modes), `src/lib/intake/scs-packet.ts` (link step), `src/lib/call-center/possible-match.ts`, tests | Unit: token round-trip, expiry, tamper, wrong org. Integration on e2e DB: packet with valid `data.attribution.pfl` sets `clientId` + event + audit; invalid token still ingests the Client; conflict keeps the first link. Text mode refused with mock SMS / no consent / DNC / out of hours |
| **PF-B Hand-off backend** | prodigyflo-orient | `prisma/schema.prisma` + migration (`SunoffHandoff`, enum `HANDOFF`), `src/lib/sunoff-bridge/{sign,payload,client,status}.ts`, `src/lib/call-center/sunoff-actions.ts`, `src/app/api/bridge/sunoff/**`, doc-rule lines in `docs/DIALER_APP.md` etc., tests | Golden-file test of `buildSunoffPayload` on a seeded Client (every §B3.4 row present or explicitly null); enum map covers every v14 option (fixture copied from SunOff `q_fields.json`); signature verify rejects skew, replay and body change; file route refuses docs not in the manifest and unsigned requests; status hook is monotonic. Migration is additive only |
| **PF-C Dialer UI** | prodigyflo-orient | `src/components/final-desk/profile-sections.tsx` (extraction), `final-desk.tsx` (uses it), `src/components/call-center/lead-profile.tsx`, `call-center.tsx` (Handoff group: SCS Intake split button, CYS Sign up + status), `model.ts` (`clientId`, `handoff`, gates), `load-leads.ts` / `from-rows.ts`, `findClientViaDeskLead` | `/clients/[id]` screenshots unchanged at 390/1440 light/dark. Dialer panel shows each of the 4 states in B2. Door test still passes (no fetch / env in screen). No overflow at 360/390. CLOSER without ownership sees a read-only profile with write actions hidden |
| **PF-D Chat host** | prodigyflo-orient | `src/app/api/chat/{token,unread}/route.ts`, `src/lib/chat-bridge/**`, `src/app/api/bridge/chat/**`, `src/components/call-center/messages/chat/**` (native, no iframe), `use-chat-host.ts`, `public/chat-sw.js`, one switch in `messages-section.tsx` | Token has no role/staff claims and expires ≤12 h; unlinked user sees the link card; case-sms refused on consent / DNC / hours / mock; feed returns phone4 only; Messages badge updates live from the chat socket's `unread` event (window event `pfchat:unread`), else from `GET /api/chat/unread`; notify emails ≤1 per 3 h |
| **S-1 SunOff hand-off** | `sunoff_work/_dialer_bridge` (+ `cys_close.py` hook calls, `case_intel` source ranks) | `server/pf_handoff.py`, `server/bridge_common.py`, `migration_pf_bridge.sql`, `/sso/pf`, doc puller job, `pf_status()` calls at cys/start + finalize/enroll + close-lost, Docs-tab badge, `tests/test_pf_bridge.py`, `deploy.sh` section | The existing 53 `dialer_close` tests stay green. New tests: bad / stale / replayed signature; create then idempotent same revision; newer revision never overwrites `manual`/`cys` FACTS; `pf_internal` docs never reach `_docs_auto`; no Supabase call before Start; Start on a standby lead pre-fills RFP, proposal (or documented gap) and questionnaire draft; status POST fired with a valid signature |
| **S-2 Chat** | sunoff-chat | `src/jwt.ts` (kid), `src/api.ts` (no elevation for pf), `src/pfcases.ts`, internal route, CORS / frame-ancestors, `via` fix, tests | A PF token can't become super/staff; `case:pf:*` SMS goes only to the PF endpoint (asserted in test with dialer URL unreachable); dedupe on `pf:<id>`; existing dialer/sunoff hosts unaffected |
| **SCS-1 Intake form** | scs-intake (the branch actually live) | `WelcomeCard.tsx` (copy `pfl`), `/begin` `fresh=1` handling | `pfl` appears in `leads.source` and in the delivered packet `data.attribution`; `fresh=1` ignores the resume cookie; no other behaviour change |

**Order:** PF-A, PF-B, S-1, S-2 and SCS-1 can start at once. PF-C starts with the profile-sections extraction and wires actions as PF-A/B land. Go-live order: SCS-1 + PF-A, then PF-C profile, then S-1 + PF-B (needs the SunOff deploy), then S-2 + PF-D.

### Owner decisions (only these)

1. **D1: Rep-assisted intake.** I recommend the homeowner submits SCS from their own phone (texted link) while the rep walks them through it. The alternative, the rep filling and attesting consents on the client's behalf, needs counsel because of the consent/recording/e-sign records. Texting needs PF SMS live (currently `mock`).
2. **D2: SunOff accounts for ProdigyFlo staff.** Link each PF user to a SunOff account (auto-provision like `dialer-provision`, recommended), or have one shared "ProdigyFlo desk" SunOff user (simpler, loses per-rep ownership in SunOff and chat). Also: which SunOff company/team they join, which sets chat visibility.
3. **D3: Cross-entity data sharing.** Sign-off from the ProdigyFlo partners (Dakota, Victor) and from OrientAI as repo owner, plus a privacy-policy / SCS consent update naming SunOff/CYS as a recipient.
4. **D4: Chat = embed the one SunOff chat** (recommended) versus a native PF chat UI, which must still use the same chat backend, never a synced copy.
5. **D5: Ship SunOff's `_dialer_bridge`** if it isn't live. S-1 builds on it and on the live `dialer_close.py`, which appears newer than the local copy.

---

## E. Open risks and unknowns

- **SunOff bridge deploy state** is contradictory (PROJECTS.md "not deployed" vs `README_DNC.md` "live"). The live `dialer_close.py` handles `purpose:"open"`, which no local copy has. S-1 must start from a fresh copy pulled from the droplet (read-only `scp`), not from `_dialer_bridge/`.
- **Which SCS branch is live.** Only `scs-intake-docbrain` (`hex/docbrain`) emits `lead_id`, `schema_42.v1` and `data.attribution`; `scs-intake` main does not. PF's receiver tests expect `stage1_answers`, which neither local payload builder shows plainly. Confirm the live packet shape before PF-A.
- **PF SMS is `mock` in production** and the subaccount's A2P status is unknown. "Text link" and chat Client-SMS stay off until both are fixed.
- **CYS needs the rep's own CYS login** in SunOff (409 `needs_cys_connect`). PF reps who start a sign-up in SunOff must connect CYS first, or it waits for someone who has.
- **Proposal-step prefill:** it isn't confirmed that SunOff's proposal form reads FACTS defaults. S-1 must verify and either add it or document the gap.
- **Option-label drift:** PF v14 labels vs CYS `q_fields.json` enums. Mitigated by the tested map plus raw `answers` carried along; `oob` and `le` wording still needs checking.
- **No testimonial exists in PF.** The testimonial comes from SunOff's story tool after hand-off.
- **Closer-packet PDFs are rendered on demand** (no stored file found). Serving them to SunOff renders per pull; watch the Vercel 300 s limit on large cases.
- **CLOSER scope change** (read via desk lead) widens who can see a Client's profile. It is audited, but it is a policy change PF partners may want to review.
- **Chat:** whether Salas, cases and migrations 004/005 are deployed is unknown. The PROJECTS.md "#general mentions-only" note contradicts the code ("all").
- **Deploy friction:** PF deploys go through PRs on `orientai-services/prodigyflo`, and Vercel blocks Hector-authored commits. Bridge routes must live on `www.prodigyflo.ai`, because the apex Worker relays only `/api/meta|telephony|inbound/`.
- **SunOff's `sunoff.app` Cloudflare 403 quirk** (connection-pool reuse) affects browsers, not server-to-server. It is not expected to matter here; noted in case.

---

## F. Owner decisions (resolved 2026-10-12, by Hector, CEO of ProdigyFlo)

- **D1 Intake: both.** The homeowner can fill the SCS intake from their own link; if they get stuck the rep can finish it with them; and a rep (or the user) may fill all of it for them. Build all three: "Text link" / "Copy link" for the client, and "Open with client (live)" for the rep to fill. When the rep fills or finishes, the SCS form records that it was rep-assisted (who, when) and each consent step shows the rep a read-aloud script and requires the rep to confirm the homeowner agreed verbally on the (recorded) call; the delivered packet carries `assisted: {by, at, mode}` and ProdigyFlo stores it on the Client/IntakeSubmission. Never fabricate a client e-signature: e-sign/LPOA/payment stay client-performed in SunOff/CYS.
- **D2 SunOff accounts:** each ProdigyFlo staff user maps to their existing SunOff user (`pf_user_link`, email match first). If none exists, the CYS Sign up / chat shows a prompt to create one (a provision call that creates the SunOff user and emails them, mirroring `dialer-provision`). Inside SunOff the existing CYS-credentials feature applies (inherit Hector's default CYS login or enter their own); do not change it.
- **D3 Sharing: approved.** Build it now. Add privacy-policy and SCS consent wording naming SunOff/CYS as a recipient of the client file for cancellation services.
- **D4 Chat: ProdigyFlo-styled screen** that is a native client of the SunOff chat Worker's existing REST + WebSocket API (same data, no second store, no sync). The iframe is not used.
- **D5 SunOff dialer bridge:** confirmed live on 2026-10-12 (`POST https://sunoff.app/api/internal/dialer-close` answers 401, not 404). S-1 starts from the droplet's live copy (`root@143.198.144.51:/opt/sunoff/server/`).

## G. Agent lanes as dispatched

| Agent | Lanes | Repos / worktrees |
|---|---|---|
| link | PF-A + SCS-1 (+ D1 assisted mode) | prodigyflo `.claude/worktrees/link` (feat/cys-link); scs-intake (live branch) worktree |
| handoff | PF-B | prodigyflo `.claude/worktrees/handoff` (feat/cys-handoff) |
| sunoff | S-1 | local working copy pulled from the droplet; deploy only when told |
| chat | S-2 + PF-D (native UI per D4) | sunoff-chat worktree; prodigyflo `.claude/worktrees/chat` (feat/cys-chat) |
| ui | PF-C | prodigyflo `.claude/worktrees/ui` (feat/cys-ui) |

No agent deploys anything to production (Vercel, droplet, Worker, SCS). The lead integrates, reviews and deploys.
