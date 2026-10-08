# Telephony live — build contract

**Status:** Plan, revision 2 (2026-10-08). No application code has changed for it yet.
**Branch:** `feat/telephony-live`, fast-forwarded to `main` at `0b03c61` (Dakota's "Meta intake: lead attribution, out-of-area flag, read-only fb checks"). No commits, pushes, PRs or deploys from the build agents.
**Carrier:** ProdigyFlo's own Twilio subaccount, "ProdigyFlo Platform". The app reads only that account. It never reads the parent account.
**Phases:** this push ships in two phases (§1.1). **P0a** is fully testable offline and deploys live. **P0b** (browser calling) deploys dark behind `VOICE_BROWSER_ENABLED` (default off) until the DA's live smoke test passes.
**Definition of done, P0a:** every outbound path (client SMS, automation SMS, Call Center "Call" via `tel:`) runs the server's do-not-call, consent and calling-hours checks. Texts show what the carrier actually did ("Blocked: texting registration pending", never a false "Sent"). Inbound calls get the right outcome, TEAM rings in turn, unknown callers keep their voicemail and become Call Center leads, and missed calls and voicemails wait in a queue until someone handles them. Recordings are stored by SID only and play only for signed-in staff through the app, with Twilio's media auth on. Facebook lead-form leads arrive dialable (hashed, normalized, consent keyed by form, state from Dakota's attribution). The owner sees the Twilio account's state on one card. Numbers sync without crossing tenants.
**Definition of done, P0b:** with the flag on, a signed-in rep calls a client or a Call Center lead from the browser with an honest caller ID that belongs to the account and can take callbacks, and inbound calls ring the reps who are online before the line's routing.
Both phases are covered by unit tests and build clean. Neither is "done" in production until the §9 live checks pass.

Line references are to `main @ 0b03c61`. No file under `src/lib/telephony/`, `src/lib/messaging/` or `src/app/api/telephony/` changed between `39bb0dc` and `0b03c61`, so the telephony line refs from revision 1 still hold.

---

## 0. Ground rules for the build agents

1. **Read `AGENTS.md` first.** This Next.js (16.3.2) is not the one in your training data. Before writing Next code, read the matching guide in `node_modules/next/dist/docs/`:
   - route handlers: `01-app/03-api-reference/03-file-conventions/route.md`
   - `after()`: `01-app/03-api-reference/04-functions/after.md`
   - `maxDuration`: `01-app/03-api-reference/03-file-conventions/02-route-segment-config/maxDuration.md`
   - `proxy.ts` (the renamed middleware): `01-app/03-api-reference/03-file-conventions/proxy.md`
   - server actions: `01-app/03-api-reference/01-directives/use-server.md`
   - client components: `01-app/03-api-reference/01-directives/use-client.md`
2. **Match the house style.** Block comments explain why, as in `src/lib/telephony/*.ts`. Pure builders and mappers are kept apart from I/O so they can be unit tested. Adapters return tagged results and never throw vendor errors at callers. REST calls use plain `fetch()` (no `twilio` npm package on the server). Use `import 'server-only'` on server modules.
3. **Reuse what exists.** That means `src/lib/telephony/*` (signature, webhook front door, TwiML builders, numbers, provider adapters, `toE164`), `src/lib/messaging/*` (send, consent, inbound, vault), `src/lib/call-center/*` (desk, contact secrets, meta-ingest), `src/lib/meta/attribution.ts` (`normalizeState`, `leadArea`, `StoredLeadAttribution`), `src/lib/meta/fixture.ts` (`metaFixtureModeEnabled`), `src/lib/crypto.ts` (`encryptSecret`, `decryptSecret`, `maskPhone`), `src/lib/audit.ts` (`recordAudit`), `src/lib/org-settings.ts` (`mergeOrgSettings`), and `src/lib/rbac.ts` (`requireUser`, `requirePermission`, `can`, `clientScope`).
4. **Dakota's Meta intake is the source of truth for lead origin.** Lead state, form id and the out-of-area flag come from `leadAttribution` / `outOfArea` as written by `src/lib/meta/attribution.ts`. Never add a parallel state column, a second state normalizer or a second form-id field. Add telephony fields next to his in the same `create` call; don't restructure his code.
5. **Separation (absolute).** ProdigyFlo runs only on its own Twilio subaccount, numbers and keys. Nothing from any other business goes into this repo: no code, names, branding, URLs, numbers, keys or data.
6. **Nothing live.** No `vercel` commands, no remote database, no Twilio or Meta API calls, no real calls or texts. Use the mock provider and `vi.stubGlobal('fetch', …)`. Local Postgres only (`prodigyflo_orient_test`, see §11).
7. **Additive migrations only:** new tables, new enums, nullable columns and indexes. One migration for this push (§5). The DA applies it to production with `prisma migrate deploy` before the deploy.
8. **Honest status everywhere.** Never write SENT, CONNECTED, "heard" or "done" unless the carrier said so. When a carrier limit blocks something, say so in plain words.
9. **Tenancy.** The platform subaccount is shared by several organizations (ProdigyFlo, SCS, CYS…). Anything account-wide (number lists, balance, errors, voice-limit mode, Messaging Services) is visible and changeable only by the **platform owner** (§2.1). Per-org admins see and change only their own org's rows.

---

## 1. Gap table

Have = works today. Partial = exists but wrong, incomplete or untested. Missing = not built. **P0a** = this push, live. **P0b** = this push, behind `VOICE_BROWSER_ENABLED`. P1 = later.

| # | Capability | Today | This push |
|---|---|---|---|
| 1 | Real carrier switched on (env) | Partial. Code paths exist, env is mock. | **P0a.** Env set and checked; status card shows which vars are present. |
| 2 | Webhook signatures behind Vercel (APP_URL / x-forwarded-host) | Partial. APP_URL only; unsigned bypass is a plain env flag. | **P0a.** Canonical-host check with an allowlist; bypass impossible in production; no line-existence leak (§2.2). |
| 3 | Import the subaccount's existing numbers | Missing. Only the buy flow writes `PhoneNumber`. | **P0a.** Platform owner assigns each platform number to one org, then imports; per-org admins sync only their own vault account (§4.4). Idempotent script. |
| 4 | Webhook drift check / repoint | Missing. | **P0a** as part of sync (repoint is opt-in per number). Scheduled drift report: **P0a** (report only). Auto-repoint: P1. |
| 5 | Voice fallback URL | Missing (no `VoiceFallbackUrl`). | **P0a.** A Twilio-hosted TwiML Bin set on every synced number and on the TwiML App. |
| 6 | Browser calling (Voice JS SDK, access token, TwiML App) | Missing. "Call" is a `tel:` link. | **P0b.** |
| 7 | Caller ID limited to the account's own lines that take callbacks | Missing. | **P0b.** Admin: any callback-capable line. Rep: own line, else the main line (§2.4). |
| 8 | Inbound rings signed-in browsers, then routing fallback | Missing. | **P0b.** One browser stage per line with `ringBrowsers`, then FORWARD / TEAM / voicemail. |
| 9 | TEAM routing rings in turn | Partial / bug. Rings everyone at once (audit 5b). | **P0a** fix: sequential. |
| 10 | Correct call outcome (status callback overwrite) | Bug (audit 5a). | **P0a** fix. |
| 11 | Unknown callers keep their voicemail | Bug (audit 5c). | **P0a.** `VoiceCall` row holds it; unknown caller becomes an INBOUND Call Center lead. |
| 12 | Missed-call / voicemail queue with badge | Missing. | **P0a** (list, player, mark handled, `tel:` call back). **P0b** adds browser call back. |
| 13 | Recording with disclosure | Partial. Inbound only, opt-in, notice spoken when on. | **P0a** inbound. **P0b** outbound recording (only browser calls record outbound). Disclosure always served when recording is on (§2.6). |
| 14 | Authenticated recording playback | Missing (Twilio URL stored, read nowhere). | **P0a.** Twilio media auth on; SID stored, never the URL; hardened streaming proxy with byte ranges (§2.6). |
| 15 | Recording archive, retention, share links | Missing. | P1. |
| 16 | Internal do-not-call list | Partial. Per-lead flag only; `CallCenterSuppression` unused. | **P0a.** One row per (org, number) with per-channel columns, checked on every outbound path. |
| 17 | Consent check on calls | Missing (SMS only). | **P0a.** One decision function for calls and texts, with `purpose` (servicing or marketing) (§2.7). |
| 18 | National / state DNC registry scrub | Missing. | P1 (FTC download import). Until then strict is the only mode: no consent = blocked. |
| 19 | Calling hours in the callee's local time, server-side | Partial. UI only, always Los Angeles time. | **P0a.** 8:00–20:00 callee-local, zones from vendored libphonenumber data plus every other hint, day-of-week and holiday rules for marketing calls. Unknown zone blocks. |
| 20 | SMS quiet hours | Missing. | **P0a.** Same rules; automation defers instead of failing. |
| 21 | STOP / opt-out on SMS | Partial. English words only; unmatched STOP lost. | **P0a.** Whole-message keywords (incl. Spanish) are automatic; a revocation word inside a longer message holds sends for admin review; STOP also revokes lead consent. |
| 22 | Honest SMS status (30034, 21408, delivery) | Missing. 201 queued is shown as SENT forever (audit 5f). | **P0a.** Status callback + sweep + plain-English error dictionary. |
| 23 | Honest voice errors (10004 concurrency) | Missing. | **P0a** (state, inbound one-leg rule, spoken errors). **P0b** (browser dial guard). Both directions counted, under a lock (§2.8). |
| 24 | Owner Twilio status card | Missing. | **P0a.** Platform owner: balance, numbers, profile / A2P, voice limit, media auth, env, errors. Others: their own numbers and errors only. |
| 25 | Vault decrypt errors silently fall back to env | Bug (audit 5j). | **P0a** fix: refuse, and show it on the card. Partial vault rows refuse too. A vault entry carrying the platform's Account SID is treated as the platform account (env token, platform-owner-only actions), and the twilio-sms / twilio-voice connector refuses to save it; with live carriers a new SID/token pair must answer Twilio's `GET /Accounts/{sid}.json`. Line webhooks verify with the line's `providerAccountSid` account when that is the platform's. |
| 26 | Release uses the wrong provider | Bug (numbers.ts:436-444). | **P0a** fix: use `row.provider`. |
| 27 | Telephony work skipped under `PRODIGYFLO_FINAL_DESK` | Gap (audit 5h). | **P0a.** New sweep runs before the early return. Renewals stay where they are (owner's call, see §10). |
| 28 | `.env.example` duplicates | Messy (audit 5k). | **P0a.** One telephony block. |
| 29 | Generic `/api/inbound/sms` cross-tenant match | Risk (audit 5i). | P1 (internal-secret door, low exposure). Test documents current behavior. |
| 30 | Number rotation, local presence, health scores, caps, warm-up | Missing. | P1. |
| 31 | Carrier trust registration (SHAKEN/STIR, CNAM, branded calling, A2P submit) | Missing. | P1. P0a only *displays* profile and A2P state. |
| 32 | Conference calls: listen-in, warm/cold transfer | Missing. | P1. |
| 33 | Dial-in bridge while voice is limited | Missing. | P1. |
| 34 | Call quality preflight, edge selection, mini dialer, tel: handler | Missing. | P1. P0b ships mic/speaker pickers and mic release. |
| 35 | Press-1 callback, missed-call auto-text, speed-to-lead nudges | Missing. | P1. |
| 36 | Voicemail transcripts, call QA | Missing. | P1. |
| 37 | Cost dashboard, per-minute / per-SMS wallet debits | Missing (`USAGE_*` unused). | P1. P0a shows balance only. |
| 38 | Monitoring: Twilio debugger alerts, synthetic test calls, alerting | Missing. | P1. |
| 39 | Per-account own Twilio voice apps (vault-stored API key + TwiML App) | Missing. | P1. P0b browser calling works only for accounts on the platform subaccount. |
| 40 | Texting Call Center leads (non-clients) | Preview only. | P1. P0a keeps the button honest: "Texting leads isn't live yet." |
| 41 | MMS | Missing; media-only texts dropped. | P1. P0a stores "[Media message]". |
| 42 | **Facebook lead intake → dialable lead** | Partial. Meta Lead Ads intake is live on `main` (Dakota, `0b03c61`): attribution, form id, state, `outOfArea`. Leads have no `phoneHash`, no consent record, bare-digit phones. | **P0a.** Wire those leads into compliant dialing: `phoneHash`, consent keyed by form id, callee state from `leadAttribution.state`, `outOfArea` as a zone hint, fixture leads never get consent (§2.13). |
| 43 | Facebook Messenger / Page inbox, Meta webhooks beyond leadgen | Missing. | P1. Out of scope for this push. |

### 1.1 Phases

- **P0a** (fully offline-testable, deploys live): rows 1–5, 9–14 (inbound recording), 16–17, 19–28, 41–42, the inbound one-leg rule from 23, and the P0a UI (status card, sync dialog, calling rules, DNC list, missed list with `tel:` call back, recording player, SMS labels, composer chip). The existing Call Center `tel:` flow gains the server checks through a `checkDial` pre-check before the `tel:` link opens.
- **P0b** (behind `VOICE_BROWSER_ENABLED`, default `false`): rows 6–8, outbound recording from 13, browser call back from 12, the browser guard from 23, and the P0b UI (voice provider, dock, call button, incoming banner, audio settings, presence). With the flag off, `getVoiceSetup()` returns `{ ready: false, reason: "Phone calling from the browser isn't switched on yet." }`, the TwiML App route answers `sayAndHangup`, `/api/voice/presence` returns 404, and no SDK code loads. The DA turns it on in Vercel env after §9 step 11(e) passes.

---

## 2. Design decisions

### 2.1 Accounts, tenancy and the platform owner

`TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` are the "ProdigyFlo Platform" subaccount. Every organization without its own vault credentials rides it (audit 5g). That is intended for internal accounts, and it means one Twilio account serves several tenants.

**Credentials come from one source.** `telephonyCredentialsDetailed(orgId)` returns `{ creds, source: 'vault' | 'platform', vaultOrgId? } | { creds: null, reason }`. `accountSid` and `authToken` are taken together from the same source. A vault row with only one of the two, or one that can't be decrypted, returns `{ creds: null, reason: 'unreadable' }` and the caller refuses. It never pairs a vault SID with the env token. `isPlatformAccount(creds)` is `creds.accountSid === TWILIO_ACCOUNT_SID` with both from env.

**Platform owner.** `TELEPHONY_PLATFORM_ORG_ID` names the organization that owns the platform subaccount (ProdigyFlo LLC's own workspace). `isPlatformOwner(user)` = the user is active, a `SUPER_ADMIN`, and their home organization (`homeOrganizationId ?? organizationId`) equals that id. A per-org `SUPER_ADMIN` of any other organization is not a platform owner. If the variable is unset, nobody is a platform owner and every platform-account-wide action refuses with "Platform owner isn't configured."

What only the platform owner can do on the platform account: number sync and the number→org assignment (§4.4), the account-wide status fields (§2.8 card), `setVoiceLimitedMode`, `setManualCarrierState`, and setting each org's Messaging Service (§2.9). An org with its own vault credentials manages those things for its own account through its own `telephony:manage` holders.

**Browser calling (P0b)** is allowed only when the org's resolved credentials are the platform credentials. An org with its own Twilio in the vault gets `{ ready: false, reason: "Browser calling isn't set up for this account's own Twilio yet." }` (P1 adds per-account voice apps).

The app never reads or changes the parent account. Numbers that serve ProdigyFlo but still sit on the parent account must be moved to the subaccount in the Twilio console first (§9, step 3).

### 2.2 Webhook authentication

Every public route under `/api/telephony/**` verifies `X-Twilio-Signature` **before** any database lookup that could reveal whether a resource exists. The token is the one for the account that owns the resource:

| Route family | How the account is found (untrusted until the signature checks out) |
|---|---|
| Number webhooks (`voice`, `voice/dial`, `voice/recording`, `voice/status`, `sms`) | `To` → `PhoneNumber` (as today) |
| Browser calls (`client/voice`, P0b) | `From = client:pf_<orgId>_<userId>` → org → its credentials (must be platform) |
| Outbound callbacks (`client/dial`, `client/status`, `client/recording`, `client/whisper`) | `?vc=<VoiceCall id>` → `VoiceCall.organizationId` |
| TwiML App parent status (`client/status?parent=1`, P0b) | `CallSid` → `VoiceCall`; else platform credentials |
| SMS status (`sms/status`) | `MessageSid` → `Communication.externalRef` → client's organization; else `From` → `PhoneNumber` |

**Unknown resource.** When the lookup finds nothing, the request is verified against the platform token. Only a request that verifies gets the "unknown resource" answer from §4.3 (`rejectTwiml`, empty TwiML or 204). An unsigned or wrongly signed request gets **403 with no body detail**, whether or not the line exists, so line existence doesn't leak to unauthenticated probes.

Then, on top of the signature:
- `AccountSid` in the form must equal the resolved credentials' `accountSid`.
- On `client/voice`, `ApplicationSid` must equal `TWILIO_TWIML_APP_SID`.

**Which URL was signed.** Twilio signs the URL it called. On Vercel the app may see a different host. The check tries, in order:
1. `APP_URL` origin + path + query (the canonical host; must be `https://www.prodigyflo.ai` in production, because the apex now 308s app paths to www).
2. `https://<x-forwarded-host>` + path + query, **only** when that host is `APP_URL`'s host or is listed in `TELEPHONY_WEBHOOK_HOSTS`.

It passes if any candidate matches, compared in constant time. An arbitrary forwarded host is never trusted.

**Unsigned bypass.** `TELEPHONY_ALLOW_UNSIGNED_WEBHOOKS=true` is honoured only when all three hold: `NODE_ENV !== 'production'`, `VERCEL_ENV !== 'production'`, and the provider is mock. In production it is ignored and logged once per cold start as a warning (the variable name only, never a value).

**Replays.** Every webhook write is idempotent on the carrier SID. `client/voice` looks up an existing `VoiceCall` by `CallSid` first and returns the same TwiML; a `P2002` on insert (a race) is caught and gives the same result, never a 500.

### 2.3 Browser calling (P0b)

- **Token:** a Twilio Access Token (JWT, HS256) minted with `jose` (already a dependency) from `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET`. TTL 3600 s. The exact claim set is pinned:
  - header: `{ alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' }`
  - payload: `{ jti: '<keySid>-<iat>', iss: '<keySid>', sub: '<accountSid>', iat, exp: iat + ttl, grants: { identity: '<identity>', voice: { incoming: { allow: true }, outgoing: { application_sid: '<TWILIO_TWIML_APP_SID>' } } } }`

  The test compares the minted token's decoded header and payload with `tests/fixtures/twilio-access-token.json`, a fixture decoded from a token minted **offline** by twilio-node's `AccessToken` + `VoiceGrant` with the same fixed key, secret, identity and clock. That fixture is generated once by a dev script (`scripts/dev/make-access-token-fixture.mjs`, which uses `npx -p twilio`; it is never imported by the app) and committed as JSON. The token is never logged or stored. The client refreshes it on the SDK's `tokenWillExpire` event.
- **Identity:** `pf_<orgId>_<userId>` (cuid ids; letters, digits and underscores only, well under Twilio's 121-character limit). It binds the browser to one organization. `client/voice` parses the org from the identity and re-checks that the user is an active member of that org with `communications:send` there. A user working in org A is registered as `pf_<A>_<user>` and is never offered org B's calls.
- **What the browser sends:** only custom params `target`, `line`, and optional `override` (see §3). Caller ID is never sent in Twilio's reserved `From`/`To`. The server resolves the real number from `target` (a client id, lead id or missed-call id) inside the user's scope, so a rep never needs to see the number.
- **What the server does on `client/voice`:** verify (§2.2) → idempotency check by `CallSid` → load the user in the identity's org → resolve the target → resolve the caller-ID line (§2.4) → run `decideOutbound` (§2.7) → in one transaction under `pg_advisory_xact_lock(hashtext(accountSid))`: the voice-limited leg count (§2.8) and the insert of the `VoiceCall` row (and, for a client, a `Communication` + `Call`) → answer TwiML:

  ```xml
  <Response>
    <Dial callerId="+1LINE" answerOnBridge="true" timeout="30"
          action="/api/telephony/client/dial?vc=ID" method="POST"
          record="record-from-answer-dual"            (only when outbound recording is on)
          recordingStatusCallback="/api/telephony/client/recording?vc=ID">
      <Number url="/api/telephony/client/whisper?vc=ID"   (only when recording is on)
              statusCallback="/api/telephony/client/status?vc=ID"
              statusCallbackEvent="initiated ringing answered completed">+1CALLEE</Number>
    </Dial>
  </Response>
  ```

  All URLs are absolute and built from `appOrigin()`. A block answers `<Say>` with the plain reason and then `<Hangup/>`.
- **Root leg status:** the TwiML App's Status Callback URL is `/api/telephony/client/status?parent=1` (§9 step 5), so the browser leg's own end finalizes the root row even if the child callback is lost.
- **Preflight:** P1. P0b only checks that the mic works (permission granted).

### 2.4 Caller-ID lines (P0b)

The line must be an `ACTIVE`, voice-capable `PhoneNumber` of the **same organization** that **can take callbacks**. TSR requires the transmitted number to be one the consumer can call back and reach during business hours.

- A line takes callbacks when its inbound path reaches a person during business hours: routing FORWARD with a valid number, or TEAM with at least one member, or browser ringing on (`ringsBrowsers(line)`, below) while browser calling is enabled.
- `ringsBrowsers(line)` = `line.ringBrowsers ?? (line.routing !== 'VOICEMAIL_ONLY')`. The new nullable `PhoneNumber.ringBrowsers` leaves existing VOICEMAIL_ONLY lines exactly as they are (no browser stage) unless a manager turns it on. VOICEMAIL_ONLY keeps its meaning.
- `telephony:manage` holders: any such line. Everyone else: their own line (`assignedUserId = me`) if it qualifies, else the account's main line (`isPrimary`) if it qualifies.
- No qualifying line → `NO_LINE`. Copy: "This account has no phone line yet." when there are no lines, and "This line can't take callbacks yet. Set it to forward, ring a team or ring browsers." when the only lines are voicemail-only.

The chosen E.164 is stamped on `VoiceCall.lineE164` at dial time. Imported numbers start as VOICEMAIL_ONLY (§4.4), so they can't be caller ID until a manager sets their routing.

### 2.5 Inbound ringing

`/api/telephony/voice` gains a browser stage (P0b; with the flag off it is skipped) ahead of the line's routing:

1. Find **present** users: `VoicePresence` rows for **the line's organization** with `lastSeenAt` within 90 s and `state = 'ready'`, the user is active in that organization and has `communications:send` there. Order: the line's `assignedUserId` first, then the client's owner (if the caller matched), then the rest by `lastSeenAt` desc. Only lines where `ringsBrowsers(line)` is true have this stage.
2. If anyone is present: greet (plus the recording notice if `recordCalls`), then `<Dial answerOnBridge="true" timeout="20" action=".../voice/dial?callSid=…&stage=browser">` with up to **5** `<Client>` legs (identity `pf_<orgId>_<userId>`). Each leg carries `<Parameter>`s `pfCallId`, `pfCaller` (client name, or `•••-•••-1234`), `pfLine` (line label) and `pfTarget` (`client:<id>`, `lead:<id>` or empty). **When voice is limited, ring exactly one** browser (the first in order), because every client leg is an outbound leg on the account.
3. Not answered (or nobody present): the dial route continues into the line's routing. FORWARD dials one number. TEAM dials each teammate **in turn**, one `<Dial>` per teammate chained through `action=...&stage=team&i=<n>` (fixes 5b; also required under the concurrency limit). VOICEMAIL_ONLY and the end of every chain record a voicemail.
4. The team list accepts any valid E.164 via `toE164`, not only 10-digit US numbers (fixes 5e).
5. **Voice limited and another bridged leg is active** (§2.8): skip the browser, FORWARD and TEAM stages and go straight to voicemail with the line's normal greeting. The `VoiceCall.stage` column records which stage the call is in, so the count is exact.

Outside business hours (the account's `Organization.timezone` + `settings.telephony.businessHours`, when set) skip the browser stage and the routing and go straight to voicemail. With no setting, every hour is business hours (today's behavior).

When voice is limited, the inbound route creates its `VoiceCall` row **inline** (one short transaction under the same advisory lock as §2.3) because the stage decision depends on the count. Otherwise the row is written in `after()`, idempotently on `CallSid`.

### 2.6 Recording and disclosure

- **Twilio media auth.** Twilio's "Enforce HTTP Basic Auth on media URLs" (Voice settings) is off by default. §9 step 4 turns it on in the subaccount **before** any recording is made. The status card shows its state (`TelephonyAccountState.mediaAuthState`): the daily sweep probes it with one **unauthenticated** `HEAD` of the newest recording's media URL (401 or 403 → `on`, 200 → `off`, no recording yet → `unknown`), and the platform owner can record a manual "confirmed on" entry. While the state is `off`, `saveCallingRules` refuses to turn outbound recording on and the card shows "Recordings are public at Twilio. Turn on HTTP auth for media."
- **What is stored.** Only the `RecordingSid`, on `VoiceCall`. No `RecordingUrl` is persisted anywhere. `Call.recordingRef` (client timelines) is written as the internal path `/api/voice/recordings/<voiceCallId>`, never the Twilio URL. This replaces today's `recordingRef: params.RecordingUrl` in `voice/dial/route.ts:26` and `voice/recording/route.ts:21`.
- **Inbound:** unchanged switch per line (`PhoneNumber.recordCalls`). The notice is spoken before ringing whenever recording is on. A `<Dial>` that records gets `recordingStatusCallback=.../voice/recording?callSid=…&kind=call`, so the recording SID lands on `VoiceCall`. `VoiceCall.recordingExpected` is set when recording is on, so the sweep can recover a lost callback.
- **Outbound (P0b):** an account setting `settings.telephony.recordOutbound` (default **off**). When it is on, the callee gets `RECORDING_NOTICE` through the `<Number url>` whisper on answer, and `VoiceCall.disclosureServedAt` is set when Twilio fetches the whisper. That records that the notice was **sent to the call**, not that anyone heard it; UI and audit say "Notice sent to the call". The setting cannot be turned on without the disclosure: there is no "record silently" switch. Nevada is treated as all-party for this purpose (not checked against the statute), and callers can be in all-party states, so the safe default is to announce every recorded call.
- **Playback proxy:** `GET|HEAD /api/voice/recordings/[voiceCallId]` (session required).
  1. Load the `VoiceCall` and run the access rule below; anything else → 404.
  2. `recordingSid` must match `^RE[0-9a-f]{32}$` (checked on write and on read); else 404 with no fetch.
  3. Use credentials whose `accountSid` equals `VoiceCall.accountSid`; if the org's current credentials are for another account, 404 with no fetch.
  4. Build the URL only as `https://api.twilio.com/2010-04-01/Accounts/${VoiceCall.accountSid}/Recordings/${sid}.mp3`, plus `?RequestedChannels=1` (mono mix; dual-channel sounds one-sided on one earbud). `?original=1` (`telephony:manage` only) omits it and returns the dual file as a download.
  5. Fetch with Basic auth, `redirect: 'manual'`, `AbortSignal.timeout(20000)`. On a 3xx, follow at most two hops, only to `https:` hosts on the allowlist (`*.twilio.com`, `*.twiliocdn.com`, `*.amazonaws.com`), **without** the Authorization header. Any other host → 502. The exact redirect host hasn't been verified; §9 step 11(e) records it and the list is narrowed then.
  6. Forward the request's `Range` header. Return the upstream status (200 or 206) with `Content-Type: audio/mpeg`, `Content-Range`, `Content-Length` and `Accept-Ranges` passed through, plus `Cache-Control: private, max-age=3600` and `Content-Disposition: inline`. Pass `upstream.body` through as a stream; never `arrayBuffer()` (Vercel's ~4.5 MB non-streamed limit). iOS Safari needs the 206. Whether Twilio honours `Range` on the mono mix hasn't been verified; if it doesn't, the proxy still returns 200 and §9 step 11(e) says so.
- **Who may play:** `telephony:manage` holders for any call in their organization. Anyone else only when one of these holds: they placed or answered the call, the call's client is in `clientScope(user)`, or the call's lead is locked by them. Everyone else gets 404, not 403, so a guessed id leaks nothing.
- **Retention:** recordings stay at Twilio as today. Archive and retention rules are P1.

### 2.7 One outbound decision: `decideOutbound`

`src/lib/telephony/compliance.ts`. Every outbound path calls it:
- Call Center "Call" (`checkDial` before the `tel:` link in P0a; before `Device.connect` in P0b)
- browser dial (the pre-check and, authoritatively, the `client/voice` webhook; P0b)
- client SMS (`sendMessage`)
- automation SMS (through `sendMessage`)

Pure core `evaluateOutbound(facts, now)`. Loader `loadOutboundFacts(...)`. **Fail closed:** any read error, or a missing `PHONE_HASH_KEY`, gives `{ allowed: false, code: 'CHECK_FAILED' }`.

**Purpose.** `decideOutbound({ channel, purpose, … })`. The purpose is derived on the server, never taken from the browser:
- `servicing`: a client who is an **active customer**: not deleted, `status` ACTIVE or ON_HOLD with the current stage's `category` in FULFILLMENT or SUBMISSION (they have signed up and the case is under way), or `status` CLOSED_WON with `stageEnteredAt` within the last 18 months (EBR purchase window). Calls about their own case aren't telephone solicitations. Basis: "Active client (stage <name>, since <date>)".
- `marketing`: every Call Center lead, every client in INTAKE / QUALIFICATION / SALES stages (Meta leads become clients there), every lost or disqualified client, and every automation SMS.

The stage mapping is this plan's reading of the pipeline; the owner confirms it with counsel (§10).

**Precedence, first match wins:**

| Step | Rule | Result |
|---|---|---|
| 1 | Not a valid number after `toE164` | `INVALID_NUMBER` |
| 2 | An active suppression row for this (org, number) blocks this channel: `callBlockedAt` for calls, `smsBlockedAt` for SMS (a legacy row with both null and `removedAt` null blocks both) | `SUPPRESSED`. Never overridable; an opt-out beats consent and purpose. |
| 3 | SMS only: the client's latest inbound SMS was a STOP, or TCPA consent revoked | `OPTED_OUT` |
| 4 | Lead has `doNotCallAt` | `SUPPRESSED` |
| 5 | Number is one of the org's own `PhoneNumber` rows, or on the manager-kept `settings.telephony.teamNumbers` list | allow, basis "Own team number". `User.phone` is never trusted for this: it is self-editable in Settings → Profile. |
| 6 | Calls only: `purpose === 'servicing'` | allow, basis "Active client (…)". No consent needed; suppression, opt-out and hours still apply. SMS to clients keeps the existing `getConsentDecision` gate in `sendMessage`. |
| 7 | Consent on file and not revoked: client `TCPA_CONTACT` granted, not revoked or expired; or lead `consentAt` with `consentRevokedAt` null and, by `consentSource`: `lead_form` (no expiry), `manual` (no expiry; the note must say where the signed consent is kept), `inbound_inquiry` (expires at `consentAt` + 90 days) | allow, basis names the source and date |
| 8 | Registry scrub | P1. Not in P0. |
| 9 | Anything else | `NO_CONSENT` ("No consent on file for this number."). **Not overridable.** |

**Strict is the only DNC mode in P0.** The earlier `confirm` mode (a rep ticks "This person asked us to contact them") is removed: a caller's own verbal claim is not a lawful basis for a number on the National DNC Registry. It may come back in P1 only for numbers checked against an imported registry file. `settings.telephony.dncMode` is not read or written in P0.

**Inbound inquiry evidence.** An inbound call or text counts as an inquiry only when it is not an opt-out: STOP / revocation texts (§2.10) never create or refresh an inquiry, and a call dispositioned "Do not call" adds a suppression (step 2 wins). A later genuine inquiry from the same number moves `consentAt` forward only when the current source is `inbound_inquiry`.

**Calling hours** (calls and texts):
- **Candidate zones** are the union of every hint, not the first match: the lead's `timeZone` (set by staff, audited); the state from `CallCenterLead.leadAttribution.state` or `Client.leadAttribution.state`, else the client's primary address state, both through `normalizeState`, mapped by `STATE_ZONES` (multi-zone states give all their zones); the number's zones from the vendored libphonenumber data (§4.1). Ported mobiles move, so the call must be inside the window in **every** candidate zone. `outOfArea === true` with no state adds nothing by itself, but it stops the code from assuming Nevada. No candidates → `UNKNOWN_TIMEZONE`.
- **Window.** `settings.telephony.callWindow` (default `{ start: 8, end: 20 }`) may be narrowed. The legal ceiling is 8:00–21:00 callee-local (federal), intersected with any `STATE_WINDOWS` rule.
- **`STATE_WINDOWS` shape:** `{ [state]: { days?: Partial<Record<0|1|2|3|4|5|6, { start: number; end: number } | null>>; holidays?: 'federal' | null; source: string } }`, evaluated in `timezones.ts`. It ships **empty**: adding a state needs a cited rule (owner or counsel).
- **Marketing default until counsel fills the table:** no calls or texts on Sundays and none on US federal holidays (`// TODO(counsel): several states restrict Sunday/holiday telemarketing; confirm per state`). A small `FEDERAL_HOLIDAYS` function computes the dates; it has unit tests for each one. Servicing calls use the account window every day.
- Outside the window → `OUTSIDE_HOURS` ("It's 9:40 pm for them. Calls can go out after 8:00 am their time."). Unknown zone → `UNKNOWN_TIMEZONE` ("We don't know their time zone. Press Call and pick where they are, then try again."). `setContactTimeZone` saves the zone on the lead, or on the client (`Client.timeZone`) when the client's address and number don't give one, e.g. a number abroad.
- **Hours override (calls only, `telephony:manage`):** it can only widen the account's narrowed window, up to the legal ceiling above, in every candidate zone. Past that ceiling, and on a marketing Sunday or holiday, `canOverride` is `null`. `UNKNOWN_TIMEZONE` is never overridable; the fix is `setContactTimeZone` ("They told us they're in X"), which is audited. An approved override returns an `overrideToken`: HMAC-SHA256 keyed by `TELEPHONY_OVERRIDE_KEY` over `{ orgId, userId, target, lineId, code, exp (2 min), nonce }`. The webhook verifies every field and stores the nonce in `VoiceCall.overrideNonce` (`@unique`); a reused nonce hits the unique index and is refused. Reps cannot override.
- **SMS:** no override, except a **reply window**: the person texted this account within the last 30 minutes and a person is answering. Automation (scheduled texts and sequence steps, `automated: true`) never uses the reply window. Automation sends outside the window are **deferred** to the next opening (no attempt counted), never failed. A `CHECK_FAILED` (the check itself couldn't run) is retried with the provider backoff, never a permanent failure.

Every block, every override and every list change writes an `AuditEvent` (`telephony.outbound_blocked`, `telephony.hours_override`, `telephony.suppression_added` / `_removed`, `telephony.consent_recorded`, `telephony.team_number_added` / `_removed`, `telephony.timezone_set`, `telephony.optout_review`). Numbers appear masked to the last 4 everywhere. Logging failures are caught and never stop a call.

**Number hashing:** `phoneHash(e164)` = HMAC-SHA256 with key `PHONE_HASH_KEY`, hex, over the `toE164` form only. It keys `CallCenterSuppression.numberHash`, `CallCenterLead.phoneHash`, `VoiceCall.remoteHash` and `teamNumbers[].hash`. `PHONE_HASH_KEY` is **never rotated** with the vault: suppression rows store no number (by design), so a key change would silently unblock every opt-out. Its note goes next to the vault rotation docs: "Do not rotate PHONE_HASH_KEY. If it ever leaks, hashes reveal nothing without a guess of the number; rotating it breaks the do-not-call list."

### 2.8 Voice-limited state (error 10004)

`TelephonyAccountState` (one row per Twilio account SID) holds `voiceLimitedMode`: `auto` (default), `on` or `off`. On the platform account only the platform owner changes it (§2.1); on a vault account, that org's `telephony:manage` holders.

`voiceLimited()` is true when:
- the mode is `on`; or
- the mode is `auto` and **either** the business profile status is not `twilio-approved` (read from Trust Hub when the subaccount can read it; else the platform owner's manual entry; if neither exists, treat it as limited) **or** a 10004 was seen in the last 24 h.

**Bridged legs.** `activeLegs(accountSid)` counts `VoiceCall` rows on that account, started within 4 h, with status `initiated` / `ringing` / `in-progress`, that hold an outbound leg: every OUTBOUND row, plus INBOUND rows whose `stage` is `browser`, `forward`, `team` or `bridged` (an inbound call in greeting or voicemail holds no outbound leg). Count and insert run in one transaction under `pg_advisory_xact_lock(hashtext(accountSid))`, so two reps dialing at once can't both pass.

When limited and `activeLegs ≥ 1`:
- An outbound browser call is refused: `VOICE_LIMITED_BUSY`, "Another call is in progress. Until Twilio approves the business profile, the account can place one call at a time." (P0b)
- An inbound call goes straight to voicemail (§2.5 step 5).

When limited and nothing else is active, inbound rings one browser at a time (§2.5). When the profile reads `twilio-approved` (or the owner sets `off`), the normal flow returns by itself. Nothing to redeploy.

Any callback carrying `ErrorCode=10004` sets `voiceLimitedSeenAt`. A failed dial is explained to the rep out loud (`<Say>` in `client/dial`) and in the dock.

**Stuck rows.** The parent leg of a browser call has a status callback (§2.3), and the sweep (§2.11) fetches Twilio's real status for any row still active after 15 min. A lost callback can't block the account for hours.

### 2.9 Honest SMS status

- `buildTwilioRequest` adds `StatusCallback=<APP_URL>/api/telephony/sms/status`.
- **Messaging Service per org.** `settings.telephony.messagingServiceSid` is set by the platform owner for orgs on the platform account (by the org's own `telephony:manage` for a vault account). When set, the request sends **both** `MessagingServiceSid` and `From=<the org's line>`, so the text goes from that org's own sender under that org's campaign. With no service set, it sends `From` only (today's behavior). There is no global `TWILIO_MESSAGING_SERVICE_SID`: one service for every org would send SCS's and CYS's texts from one pool under one brand.
- A2P status is read **per service** (the service's attached campaign), and stored per org in `settings.telephony.a2p` (`{ status, source, checkedAt }`).
- The `SendResult` contract does not change. SENT still means "the carrier accepted it". The **UI label** for an SMS in SENT is "Accepted by carrier". DELIVERED is shown only after the callback says `delivered`.
- `/api/telephony/sms/status` maps the status:
  - `delivered` → `DELIVERED` + `deliveredAt`
  - `undelivered` / `failed` → `FAILED` + `failureCode = "<code>: <plain meaning>"`
  - `sent` / `queued` / `accepted` / `sending` → leaves the status at SENT and records `providerStatus`

  It is idempotent and only moves forward (FAILED and DELIVERED are terminal). The lookup uses the new index on `Communication(externalRef)`.
- The sweep (§2.11) fetches messages still SENT after 10 minutes with no terminal callback, 25 per run, so a lost callback cannot leave "Accepted" forever.
- `carrier-errors.ts` holds the plain-English dictionary and `smsStatusLabel(status, failureCode)`. Initial codes: 30034 (blocked: texting registration (A2P) pending), 21408 (blocked: texting to that country isn't enabled), 21610 (they opted out at the carrier), 21211 (not a valid number), 21614 (not a mobile number), 30003 (phone unreachable), 30005 (unknown number), 30006 (landline or carrier can't take texts), 30007 (carrier filtered it), 30008 (carrier error, unknown), 10004 (account allows one call at a time), 13227 (no permission to call that country). Any other code shows as "Carrier error <code>" with a link to Twilio's error page. Do not invent meanings: each entry needs Twilio's docs URL in a comment.
- The composer shows a warning chip when the org's last-known A2P state is not approved: "Texts may be blocked until texting registration is approved." It does **not** pre-block sends; the carrier's answer is reported as it is, so texting works the day A2P clears.

### 2.10 STOP / opt-out

- **Automatic (whole message).** `STOP_WORDS` adds `optout`, `opt out`, `opt-out`, `revoke`, `parar`, `alto`, `baja`, `cancelar`, matched against the whole trimmed, case-folded message as today.
- **Review hold (clear request inside a longer message).** When a message isn't a whole-message keyword but contains a clear revocation PHRASE (`stop texting`, `please stop`, `no more texts`, `do not contact`, `opt out`, `unsubscribe`, `dejen de escribir`, `no me manden mensajes`, … see `REVOCATION_PHRASES`) or opens with "STOP" and punctuation, the number gets an SMS block with source `sms_stop_review`, and admins get a notification "Possible opt-out: '<first 80 chars>'. Confirm or lift." Single words such as `cancel`, `cancelar`, `end`, `alto`, `baja` and `quit` do NOT hold inside a sentence: solar-cancellation clients use them in ordinary replies. `reviewSmsOptOut(id, 'confirm' | 'lift', note)` (`telephony:manage`) turns it into `sms_stop` or clears it, audited. Confirming also revokes the matching clients' TCPA consent, like a bare STOP. Sends to that number are held meanwhile; automation waits (re-checked every 2 hours) instead of failing.
- A STOP from a **matched** client revokes TCPA consents (as today) **and** sets the SMS block on the suppression row (`smsBlockedAt`, `smsBlockedSource: 'sms_stop'`).
- A STOP from an **unmatched** number sets the SMS block in the line's organization (fixes "recorded nowhere") and notifies admins.
- A STOP also sets `consentRevokedAt` on every `CallCenterLead` in the org with that `phoneHash`, so a lead who texted STOP is no longer callable on form consent (§2.7 step 7). The call block itself (`callBlockedAt`) stays an owner choice (§10).
- If saving the opt-out fails, an admin notification "Opt-out not saved — add it by hand" is raised. It is never dropped silently.
- `START` / `UNSTOP` clear `smsBlockedAt` only where `smsBlockedSource = 'sms_stop'`. They never touch a call block, a `sms_stop_review` hold or a manual block, and they do **not** restore consent; staff must record consent again.
- The app never sends its own auto-reply to STOP. Twilio answers its standard keywords itself.
- STOP and revocation texts never count as an inbound inquiry (§2.7).
- Inbound media-only messages (empty Body with `NumMedia > 0`) are stored as "[Media message]" instead of being dropped (MMS content stays P1).

### 2.11 Cron: `runTelephonySweep(now)`

`src/lib/telephony/sweep.ts`. It is called from `/api/jobs/run` **before** the `PRODIGYFLO_FINAL_DESK` early return, and never throws (it returns a summary). Every Twilio fetch uses `AbortSignal.timeout(5000)`, and the sweep checks its 20 s budget before each step and each item. Steps:
1. Refresh `TelephonyAccountState` when `lastCheckedAt` is older than 60 min: balance, profile, per-org A2P, media auth probe (daily).
2. SMS status sweep (§2.9).
3. Calls still active after 15 min: fetch the call's real status from Twilio (parent `CallSid`) and apply it. Still active after 4 h and the fetch fails → `status = 'unknown'`, with no outcome guessed.
4. Lost recordings: `VoiceCall` rows ended more than 5 min ago with `recordingExpected` and no `recordingSid` → `GET Calls/{CallSid}/Recordings.json`, store the SID.
5. Daily webhook drift report per synced number: it records `PhoneNumber.webhookDrift` and never repoints (auto-repoint is P1).
6. Expire presence: delete `VoicePresence` rows older than 10 min.

`PRODIGYFLO_MAINTENANCE=true` makes the proxy answer 503 to all `/api/telephony/**`, and Twilio does not retry status or recording callbacks. Steps 2–4 reconcile what was dropped once maintenance ends; voicemails left during maintenance are lost (the fallback TwiML Bin records them at Twilio instead, §9 step 4).

### 2.12 Unknown callers become leads

When an inbound call does not match a client:
- `VoiceCall` stores `remoteSecret` (`encryptSecret` of the E.164), `remoteLast4` and `remoteHash`.
- The voice route's `after()` upserts a `CallCenterLead` in the line's organization, deduped on `(organizationId, phoneHash)` (so an existing Meta lead for the same number is reused once its hash is backfilled, §2.14): source `INBOUND`, status `INBOUND` (`MISSED` when unanswered), language `EN`, `phoneHash` / `phoneLast4` / `phoneSecret`. No consent is written while the call rings. When the call is finalized, the lead gets `consentSource = 'inbound_inquiry'`, `consentAt = startedAt` (90-day expiry, §2.7) only when the carrier attested the caller ID (`StirVerstat` `TN-Validation-Passed-A` or `-B`, stored on `VoiceCall.stirVerstat`) AND the caller reached someone or left a voicemail of 3 seconds or more. An existing lead's consent moves forward only if its source is already `inbound_inquiry` or it has none.
- A `CallCenterEvent` of type `INBOUND` is written.
- The admin notification links to `/call-center?missed=<voiceCallId>`.

### 2.13 Facebook: lead intake → compliant dialing

Meta Lead Ads intake is live on `main` (Dakota, `0b03c61`): `src/lib/meta/attribution.ts` stores `leadAttribution` (ad, ad set, campaign, **form id**, platform, normalized **state**) and `outOfArea` on both `CallCenterLead` and `Client`. This push wires those leads into dialing and changes nothing about how they are fetched or routed:

- **Hash and normalize.** `ingestCallCenterMetaLead` adds `phoneHash: phoneHash(toE164(phone))` in the same `tx.callCenterLead.create` data object, next to `leadAttribution` and `outOfArea`. Existing leads are backfilled (§2.14).
- **Consent by form.** `settings.telephony.consentForms: { [formId]: textVersion }`, written only by `telephony:manage` and audited. At ingest, when `leadAttribution.formId` is in that map, the lead gets `consentAt = now`, `consentSource = 'lead_form'`, `consentTextVersion = <textVersion>`, `consentFormId = <formId>`. Adding a form to the map is the owner's statement that this exact form carries the consent language. Forms not in the map give no consent. Adding a form later does not stamp leads already in (no retroactive consent).
- **Never stamp fixture leads.** When the webhook ran in fixture mode (`metaFixtureModeEnabled()`), the route passes `fixture: true` down to `ingestCallCenterMetaLead`, which then writes no consent fields.
- **State and zone.** The callee state for hours is `leadAttribution.state` through Dakota's `normalizeState` (§2.7). `outOfArea` is a hint that the lead is not in Nevada; it never adds a column or a concept.
- **Clients from Meta** (the non-Call-Center path) keep their attribution on `Client.leadAttribution`; they start in intake stages, so they are `marketing` and need consent (§2.7).
- **Out of scope:** Messenger / Page inbox, Instagram DMs as a calling source, any Meta webhook other than leadgen, and any write to Meta. Those are P1.
- **Read-only checks for the DA** (§9 step 10): `node tools/meta.mjs status`, `check-token`, `check-subscription`. No `subscribe` and no `test-lead` against production.

### 2.14 Phone normalization and backfill

- Every hash, dial and comparison goes through `toE164` first. `contactSecrets` stores `dialablePhone()` output, which is bare digits for a 10-digit US number (`7025551234`), so readers normalize on the way out; the stored blob is not rewritten.
- `scripts/telephony-backfill-phone-hash.ts` (dry run by default; `--execute` writes): for each `CallCenterLead` with `phoneSecret` and no `phoneHash`, decrypt, `toE164`, set `phoneHash`. Idempotent; prints counts only (no numbers). Rows whose phone won't normalize are counted and left alone. The DA runs it after `migrate deploy` (§9 step 7).

---

## 3. Shared API contract

The backend writes `src/lib/telephony/voice-contract.ts` **first, exactly as below**: types and constants only, no `server-only`, no imports from server modules. The UI package codes against it. Server actions live in `src/lib/telephony/actions.ts` (`'use server'`). Each one re-checks permissions, and none returns a secret, a token other than the voice JWT, or a full phone number to anyone without `telephony:manage` in the owning org.

```ts
// src/lib/telephony/voice-contract.ts
export type DialTarget =
  | { kind: 'client'; id: string }
  | { kind: 'lead'; id: string }        // CallCenterLead id
  | { kind: 'missed'; id: string }      // VoiceCall id: call back an unknown caller

export type CallerLine = { id: string; display: string; label: string; isDefault: boolean }

export type VoiceSetup =
  | { ready: true; identity: string; lines: CallerLine[]; canPickLine: boolean;
      voiceLimited: boolean; recordOutbound: boolean; mode: 'twilio' | 'mock' }
  | { ready: false; reason: string }    // plain English, shown as-is (also when VOICE_BROWSER_ENABLED is off)

export type VoiceToken = { token: string; identity: string; expiresAt: string } // ISO

export type OutboundPurpose = 'servicing' | 'marketing'

export type OutboundBlockCode =
  | 'INVALID_NUMBER' | 'NO_NUMBER' | 'NOT_IN_SCOPE' | 'LOCKED_BY_OTHER'
  | 'SUPPRESSED' | 'OPTED_OUT' | 'NO_CONSENT' | 'OUTSIDE_HOURS' | 'UNKNOWN_TIMEZONE'
  | 'VOICE_LIMITED_BUSY' | 'NO_LINE' | 'NOT_CONFIGURED' | 'NO_PERMISSION' | 'CHECK_FAILED'

export type DialCheck =
  | { ok: true; who: string;            // name, or masked number
      purpose: OutboundPurpose;
      calleeLocalTime: string;          // "2:14 pm"
      calleeZone: string;               // IANA, or "several zones"
      line: CallerLine | null;          // null in P0a (tel: flow)
      basis: string;                    // "Consent on file (form 1234, Oct 2)"
      overrideToken?: string            // present only after an approved hours override
      dial?: string }                   // E.164 for the tel: flow (line null), telephony:manage only (integration, §14)
  | { ok: false; code: OutboundBlockCode; reason: string;
      canOverride: 'hours' | null }     // 'hours' only inside the legal ceiling (§2.7)

/** Custom params on Device.connect(). The server trusts nothing else from the browser. */
export type ConnectParams = {
  target: string      // 'client:<id>' | 'lead:<id>' | 'missed:<id>'
  line: string        // PhoneNumber id
  override?: string   // overrideToken from checkDial
}

/** <Parameter>s on an incoming browser leg. */
export const INCOMING_PARAMS = ['pfCallId', 'pfCaller', 'pfLine', 'pfTarget'] as const

export type MissedCallVM = {
  id: string; at: string; lineLabel: string; caller: string
  target: DialTarget | null
  reason: 'no-answer' | 'hung-up' | 'voicemail' | 'busy' | 'failed'
  voicemail: { src: string; seconds: number } | null
}

export type CarrierState = { status: string; source: 'twilio' | 'manual' | 'unknown'; note: string }

export type TwilioStatusVM = {
  mode: 'mock' | 'twilio'
  /** 'platform' when the viewer is the platform owner looking at the platform account. */
  scope: 'platform' | 'org'
  account: string                       // "AC…1234", never the token
  balance: string | null                // "$41.20"; null unless scope is 'platform' or the org's own vault account
  numbers: { inTwilio: number | null; here: number; drift: number } // inTwilio null for scope 'org' on the platform account
  profile: CarrierState
  a2p: CarrierState                     // this org's Messaging Service
  voiceLimited: { on: boolean; mode: 'auto' | 'on' | 'off'; why: string; canChange: boolean }
  mediaAuth: { state: 'on' | 'off' | 'unknown'; checkedAt: string | null }
  env: { name: string; set: boolean }[] // empty unless scope is 'platform'
  recentErrors: { code: string; meaning: string; count: number; lastAt: string }[] // this org's calls and texts only, unless scope is 'platform'
  checkedAt: string | null
}

export type SyncRowVM = {
  sid: string
  display: string                       // full E.164 only when the viewer may see it, else "•••-•••-1234"
  friendlyName: string
  state: 'new' | 'here' | 'other-account' | 'released-here' | 'unassigned'
  assignedOrg: { id: string; name: string } | null  // platform owner only
  otherAccount: string | null           // name only for the platform owner, else "another account"
  voiceUrlHost: string | null; pointsHere: boolean
  capabilities: { voice: boolean; sms: boolean; mms: boolean }
}
export type SyncPreviewVM = { account: string; platform: boolean; organizationName: string; rows: SyncRowVM[] }
export type SyncResultVM = { imported: number; updated: number; repointed: number; skipped: { sid: string; reason: string }[] }

export type SuppressionVM = {
  id: string; last4: string; reason: string; by: string | null
  sms: { at: string; source: string } | null
  call: { at: string; source: string } | null
}
export type CallingRulesVM = { recordOutbound: boolean; windowStart: number; windowEnd: number } // strict DNC is the only mode in P0
```

Server actions (`src/lib/telephony/actions.ts`). The result shape follows `NumberActionResult`: `{ ok: true, ... } | { ok: false, error, code? }`. "Platform owner" is §2.1.

| Action | Who | Returns |
|---|---|---|
| `getVoiceSetup()` | any staff | `VoiceSetup` |
| `getVoiceToken()` | `communications:send`; flag on (P0b) | `VoiceToken` or `{ ok:false, error }` |
| `checkDial(target, lineId?, override?: { kind: 'hours'; reason: string })` | `communications:send` | `DialCheck` |
| `listMissedCalls()` | any staff (scope rules of §2.6) | `MissedCallVM[]` |
| `markMissedCallHandled(id, note?)` | any staff who can see it | result |
| `previewNumberSync(organizationId?)` | platform owner on the platform account; else `telephony:manage` of the org whose **own vault** holds the credentials | `SyncPreviewVM` |
| `setNumberAssignment({ sid, organizationId \| null })` | platform owner | result |
| `applyNumberSync({ organizationId?, importSids, repointSids })` | same as preview | `SyncResultVM` |
| `getTwilioStatus(refresh?: boolean)` | `telephony:read` (fields scoped as in `TwilioStatusVM`) | `TwilioStatusVM` |
| `setVoiceLimitedMode(mode)` | platform owner (platform account); else that vault org's `telephony:manage` | result |
| `setManualCarrierState({ profile?, a2p?, mediaAuth? })` | same as above | result |
| `setMessagingService({ organizationId, sid \| null })` | platform owner (platform account); else that vault org's `telephony:manage` | result |
| `listSuppressions()` / `addSuppression({ phone, sms: boolean, call: boolean, reason })` / `removeSuppression(id, note)` | read: `communications:send`; add: `communications:send`; remove: `telephony:manage` | `SuppressionVM[]` / result |
| `reviewSmsOptOut(id, decision: 'confirm' \| 'lift', note)` | `telephony:manage` | result |
| `listTeamNumbers()` / `addTeamNumber({ phone, label })` / `removeTeamNumber(hash)` | `telephony:manage` (audited) | list (last 4 + label) / result |
| `recordConsent({ target, note })` | `telephony:manage` | result |
| `setConsentForms({ formId, textVersion \| null })` | `telephony:manage` (audited) | result |
| `setContactTimeZone({ target, zone, note })` | `communications:send`, target in scope (audited) | result |
| `getCallingRules()` / `saveCallingRules(rules)` | read: staff; save: `telephony:manage` | `CallingRulesVM` / result |

Route handlers (browser-facing, session-checked):
- `GET|HEAD /api/voice/recordings/[voiceCallId]` → `audio/mpeg` 200 or 206, or 401/404. `?original=1` (manage only) → dual-channel download.
- `POST /api/voice/presence` (P0b) → body `{ state: 'ready' | 'offline' }` (JSON or `text/plain` from `sendBeacon`), 204. It checks the session and that the `Origin` header equals `APP_URL`'s origin. The heartbeat uses plain `fetch` every 60 s; `pagehide` uses `navigator.sendBeacon`. Server actions are not used for presence: they queue serially per client and `pagehide` aborts them.

`src/lib/call-center/model.ts`: `TrailEvent` gains `recording?: { src: string; seconds: number }` (real), and `DummyRecording` is used only by the seed. `CallLead` gains `missedCallId?: string`. The backend fills these in `loadCallCenterLeadsFor`.

`src/lib/telephony/carrier-errors.ts` (no `server-only`) exports `explainCarrierError(code)` and `smsStatusLabel(status, failureCode)` for the UI.

---

## 4. Backend package

Owns `src/lib/**` (except `src/lib/**/ui/**`), `src/app/api/**`, `src/proxy.ts`, `prisma/**`, `scripts/**`, `tests/**`, `vercel.json`, `.env.example`. It does not edit `package.json` (no new server deps: `jose` is already there).

### 4.1 New files

| File | Phase | What |
|---|---|---|
| `src/lib/telephony/voice-contract.ts` | P0a | §3, written first. |
| `src/lib/telephony/access-token.ts` | P0b | `mintVoiceToken({ accountSid, apiKeySid, apiKeySecret, appSid, identity, ttl, now })`: pure, built on `jose`, claim set pinned in §2.3. Also `voiceIdentity(orgId, userId)` / `parseIdentity('client:pf_<org>_<user>')`. |
| `src/lib/telephony/voice-config.ts` | P0b | `voiceConfig()`: reads `VOICE_BROWSER_ENABLED`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` and `TWILIO_TWIML_APP_SID`, returns `{ ready, missing[] }`. `voiceSetupFor(user)` gives the `VoiceSetup` (platform-account rule from §2.1, lines from §2.4). |
| `src/lib/telephony/tenancy.ts` | P0a | `isPlatformOwner(user)`, `credentialScope(orgId)` (platform vs own vault), the guards the actions use. |
| `src/lib/telephony/lines.ts` | P0b | `callerLinesFor(user)`, `resolveCallerLine(user, lineId?)`, `ringsBrowsers(line)`, `takesCallbacks(line)`. |
| `src/lib/telephony/targets.ts` | P0a | `resolveDialTarget(actor, target)` → `{ e164, who, clientId?, leadId?, voiceCallId?, purpose, zoneHints }`, scope-checked: client via `clientScope`; lead in org **and** locked by the actor (desk rule); missed `VoiceCall` in org. |
| `src/lib/telephony/compliance.ts` | P0a | `phoneHash`, `outboundPurpose`, `evaluateOutbound` (pure), `loadOutboundFacts`, `decideOutbound`, `signOverride` / `verifyOverride`, `deferUntil(now, zones, rules)`, `isRevocationText`. |
| `src/lib/telephony/timezones.ts` | P0a | `STATE_ZONES`, `STATE_WINDOWS = {}`, `FEDERAL_HOLIDAYS(year)`, `calleeZones(hints)` (union of all hints), `windowOk(zones, now, rules, purpose)`, `localTimeIn(zone, now)`. Area-code zones come from the generated data file below; nothing is hand-typed. |
| `src/lib/telephony/data/nanp-timezones.json` | P0a | Generated, not hand-written: NANP prefix → IANA zones from Google libphonenumber's `resources/timezones/map_data.txt` (the data behind `PhoneNumberToTimeZonesMapper`, Apache-2.0). Header fields: source URL, libphonenumber commit hash, SHA-256 of the source file, generated date, license. Any prefix missing from it is unknown. |
| `scripts/gen-nanp-timezones.ts` | P0a | Reads a local copy of `map_data.txt` fetched from the pinned commit's raw URL, keeps `+1` entries, writes the JSON above. The fetch is a public GitHub file, not a carrier call; the agent records the commit it used. |
| `src/lib/telephony/carrier-errors.ts` | P0a | §2.9. |
| `src/lib/telephony/voice-calls.ts` | P0a | The `VoiceCall` ledger: `startInboundCall`, `startOutboundCall`, `activeLegs` (under the advisory lock), `applyCallStatus` (idempotent, forward-only), `applyDialResult`, `applyRecording`, `finalizeCall` (CONNECTED ≥ 20 s talk → `Client.firstContactAt ??= now`; writes the lead's CALL event with real text; sets `needsAction` on unanswered inbound), `listMissed`, `markHandled`, `canPlayRecording`. |
| `src/lib/telephony/presence.ts` | P0b | `touchPresence(user, orgId, state)`, `presentUsersFor(number, callerClientOwnerId?)`. |
| `src/lib/telephony/account-status.ts` | P0a | `refreshAccountState(accountSid)`, `getAccountState`, `voiceLimited(accountSid, now)`, `noteCarrierError(accountSid, code)`, `probeMediaAuth`. Mock gives `{ mode: 'mock' }`. |
| `src/lib/telephony/number-sync.ts` | P0a | `previewNumberSync(user, orgId?)`, `applyNumberSync(user, input)`, `syncNumbersForScript({ execute, repoint })`. Rules: §4.4. |
| `src/lib/telephony/sweep.ts` | P0a | §2.11. |
| `src/lib/telephony/recording-media.ts` | P0a | `recordingMediaRequest(voiceCall, creds, { mono, range })` (pure builder, all §2.6 checks) and `fetchRecordingMedia(...)` (manual redirects, allowlist, streaming). |
| `src/lib/telephony/actions.ts` | P0a/P0b | `'use server'` actions from §3. |
| `src/app/api/telephony/client/voice/route.ts` | P0b | TwiML App Voice URL (§2.3). |
| `src/app/api/telephony/client/dial/route.ts` | P0b | Dial action for outbound: finalize; on failure `<Say>` the plain reason to the rep (10004 explained), then `<Hangup/>`. |
| `src/app/api/telephony/client/status/route.ts` | P0b | Child-leg status (`?vc=`) and root status (`?parent=1`): `answeredAt`, `childCallSid`, status, `ErrorCode`. Returns 204. |
| `src/app/api/telephony/client/recording/route.ts` | P0b | Recording status → `recordingSid` (validated), duration. Returns 204. |
| `src/app/api/telephony/client/whisper/route.ts` | P0b | `<Say>RECORDING_NOTICE</Say>`, sets `disclosureServedAt`. |
| `src/app/api/telephony/sms/status/route.ts` | P0a | §2.9. Returns 204. |
| `src/app/api/voice/recordings/[voiceCallId]/route.ts` | P0a | §2.6. `export const maxDuration = 60`. |
| `src/app/api/voice/presence/route.ts` | P0b | §3. 404 when the flag is off. |
| `scripts/telephony-sync-numbers.ts` | P0a | `npx tsx scripts/telephony-sync-numbers.ts [--execute] [--repoint]`. Dry run by default. Uses env (platform) credentials only, and imports **only** the sid→org pairs in the platform owner's assignment map (§4.4); it never takes an `--org` to import into. Prints a table with numbers masked to the last 4 and SIDs shortened. Runs as no user (audit `actorLabel: 'Number sync script'`). Idempotent. |
| `scripts/telephony-backfill-phone-hash.ts` | P0a | §2.14. |
| `scripts/dev/make-access-token-fixture.mjs` | P0b | §2.3. Dev-only; never imported by the app. |

Every new public route file: `POST` only, signature first, short work inline, everything else in `after()`. TwiML routes answer `TWIML_CONTENT_TYPE`; status routes answer 204.

### 4.2 Edited files

| File | Change |
|---|---|
| `src/lib/telephony/signature.ts` | `candidateWebhookUrls(request, appOrigin, extraHosts)`; `validateTwilioSignatureAny({ authToken, urls, params, header })`. Keep `publicWebhookUrl` for compatibility. |
| `src/lib/telephony/webhook.ts` | `authenticateWebhook` uses candidates + `AccountSid` check + `allowUnsignedWebhooks()` + the unknown-resource rule (§2.2: platform-token check before `rejectTwiml`, else 403). Add `authenticateClientWebhook(request, by: 'identity' \| 'voiceCall' \| 'parent')` and `authenticateSmsStatusWebhook(request)`. `callbackUrls` gains `stage`/`i`/`kind`. |
| `src/lib/telephony/index.ts` | `telephonyCredentialsDetailed` (§2.1): one source per pair, partial or unreadable vault rows refuse, no silent env fallback. `telephonyCredentials` (index.ts:62-70) becomes a thin wrapper that returns `null` on refusal. `webhooksFor()` adds `voiceFallbackUrl` from `TWILIO_VOICE_FALLBACK_URL`. `isPlatformAccount(creds)`. |
| `src/lib/telephony/provider.ts` | `NumberWebhooks.voiceFallbackUrl?`. Interface adds `listOwnedNumbers(creds)` → `OwnedNumber[]` (`{ sid, e164, friendlyName, capabilities, voiceUrl, smsUrl, statusCallback, voiceFallbackUrl, dateCreated }`) and `updateWebhooks(sid, webhooks, creds)`. |
| `src/lib/telephony/twilio.ts` | Builders/parsers: `buildListNumbersRequest` (PageSize 1000; follow `next_page_uri`), `parseListNumbersResponse`, `buildUpdateWebhooksRequest` (VoiceUrl, VoiceMethod, VoiceFallbackUrl, StatusCallback, SmsUrl), `buildBalanceRequest`/`parseBalance`, `buildFetchMessageRequest`/`parseMessageStatus`, `buildFetchCallRequest`/`parseCallStatus`, `buildCallRecordingsRequest`, `buildCustomerProfilesRequest`/`parseProfileStatus`, `buildA2pStatusRequest(serviceSid)`/`parseA2pStatus`. `buildPurchaseRequest` adds `VoiceFallbackUrl` when set. |
| `src/lib/telephony/mock.ts` | Implements the two new methods over its fiction numbers. |
| `src/lib/telephony/twiml.ts` | `browserDialTwiml` (≤ 5 `<Client>` with `<Parameter>`s), `teamStepTwiml(i)` (one number per step), `outboundDialTwiml`, `whisperTwiml`, `sayAndHangup(reason)`. Voicemail `<Record>`: keep `action`, point `recordingStatusCallback` at `…&kind=voicemail` (idempotent). Fix the header comment to match sequential TEAM. |
| `src/lib/telephony/calls.ts` | `teamDialNumbers` uses `toE164`. `updateCallOutcome` no longer maps a parent `completed` to CONNECTED: the outcome comes only from the dial result or the voicemail (fixes 5a). `recordInboundCall` also starts the `VoiceCall`, and does the lead upsert for unknown callers (§2.12). Notification href points to the missed call. |
| `src/app/api/telephony/voice/route.ts` | Business-hours check → voice-limited check (inline row under lock when limited) → browser stage (P0b, `ringsBrowsers`) → routing. Otherwise `VoiceCall` created in `after()`, idempotent. |
| `src/app/api/telephony/voice/dial/route.ts` | Stage machine: `browser` → routing; `team&i=n` → next teammate or voicemail; records `answeredBy` and `stage`. Sets `needsAction` on no-answer. Stops writing `RecordingUrl` (line 26): `Call.recordingRef` = `/api/voice/recordings/<voiceCallId>`. |
| `src/app/api/telephony/voice/status/route.ts` | Parent leg: sets `endedAt` and duration; caller hung up with no dial result → NO_ANSWER + `needsAction` ("hung up while ringing"). Never overwrites a dial or voicemail outcome. |
| `src/app/api/telephony/voice/recording/route.ts` | `kind=call\|voicemail`; validates and stores the SID on `VoiceCall`; `Call.recordingRef` = the internal path, never `RecordingUrl` (line 21). |
| `src/app/api/telephony/sms/route.ts` | Media-only messages kept (§2.10). |
| `src/lib/telephony/numbers.ts` | `releaseNumber` uses `row.provider`'s adapter (mock or twilio) and that account's credentials. Provisioning stamps `providerAccountSid`. |
| `src/lib/messaging/twilio.ts` | `StatusCallback`; per-org `MessagingServiceSid` **plus** `From` when the org has a service (§2.9); error text includes the code so `explainCarrierError` can read it. |
| `src/lib/messaging/send.ts` | Before creating the row: for SMS, `decideOutbound({ channel: 'SMS', purpose })` (suppression, opt-out, hours with reply window). The block codes go into `SendOutcome.code`. Consent stays in `getConsentDecision` (unchanged order: consent gate, then compliance). |
| `src/lib/automation/engine.ts` | `OUTSIDE_HOURS` from `sendMessage` → reschedule to `deferUntil(...)`, attempt not counted. Automation sends are `marketing`. |
| `src/lib/messaging/consent.ts` | `STOP_WORDS` additions; `isStartMessage`; `isRevocationText` (keyword inside a longer message). |
| `src/lib/messaging/inbound.ts` | STOP → SMS block (matched and unmatched) + lead `consentRevokedAt`; revocation word → `sms_stop_review` hold + notification; START → clear only `sms_stop`; save failure → admin notification. |
| `src/lib/messaging/vault.ts` | Distinguish "none stored" from "stored but unreadable" and "partial"; expose `vaultCredentialsDetailed`. Callers that need certainty (telephony) refuse on unreadable or partial. |
| `src/lib/call-center/desk.ts` | `recordCarrierCallFor(organizationId, leadId, voiceCall)`: system write of a real CALL event + tries rule. `recordCallCenterAttemptFor` stays for the `tel:` flow (P0a, and P0b when voice isn't ready). `loadCallCenterLeadsFor` fills `recording` / `missedCallId`. The "Do not call" outcome sets `callBlockedAt` and `smsBlockedAt` on the org suppression row (source `call_center`). |
| `src/lib/call-center/model.ts` | Contract additions (§3). `PREVIEW_BANNER` is used only when voice isn't ready. |
| `src/lib/call-center/meta-ingest.ts` | In the existing `tx.callCenterLead.create` data object, next to `leadAttribution` / `outOfArea`: `phoneHash`, and the consent fields only when `attribution.formId` is in `settings.telephony.consentForms` and the input is not `fixture` (§2.13). New optional input `fixture?: boolean`. Nothing else in Dakota's flow changes. |
| `src/app/api/meta/leads/route.ts` | Pass `fixture` (already computed there from `metaFixtureModeEnabled()`) through `recordMetaWebhookLead` to `ingestCallCenterMetaLead`. One added property; nothing else. |
| `src/lib/staff-routes.ts` | CLOSER API allowlist adds `voice` (covers `/api/voice/recordings` and `/api/voice/presence`). |
| `src/lib/final-desk/routes.test.ts` | Add an assertion that a CLOSER may reach `/api/voice/recordings/x` and `/api/voice/presence`. Do **not** change the existing `/settings/phone-numbers` assertion. |
| `src/app/api/jobs/run/route.ts` | `const telephonySweep = await runTelephonySweep(new Date())` right after `recordsStaff`, before the FINAL_DESK return; included in both JSON bodies. |
| `src/proxy.ts` | No change needed: `/api/telephony` is already public and signature-gated; `/api/voice` stays session-gated. |
| `.env.example` | One telephony block (§7), duplicates removed. |

### 4.3 What each route returns (Twilio-facing)

"Unknown" answers go only to requests that verified against the platform token (§2.2); everything unsigned or mis-signed is 403.

| Route | Bad signature | Unknown resource (signed) | Blocked | OK |
|---|---|---|---|---|
| `voice` | 403 | 200 `rejectTwiml` | n/a | 200 TwiML |
| `voice/dial`, `voice/recording` | 403 | 200 empty TwiML | n/a | 200 TwiML |
| `voice/status`, `client/status`, `client/recording`, `sms/status` | 403 | 204 | n/a | 204 |
| `client/voice` | 403 | 200 `sayAndHangup("We couldn't place this call.")` | 200 `sayAndHangup(reason)` | 200 dial TwiML (same TwiML on replay) |
| `client/dial` | 403 | 200 empty | n/a | 200 (`<Say>` on failure) |
| `client/whisper` | 403 | 200 empty | n/a | 200 `<Say>` notice |

### 4.4 Number sync rules

**Who may sync which account.**
- **Platform account** (resolved credentials are the platform's): only the platform owner. A per-org `SUPER_ADMIN` of SCS, CYS or any other org gets "Number sync for the shared account is done by the platform owner." and sees no rows.
- **An org's own vault account:** that org's `telephony:manage` holders, importing into that org only.

**Assignment map (platform account).** The platform owner assigns each platform number to exactly one organization: `setNumberAssignment({ sid, organizationId })`, stored in the platform org's settings as `settings.telephony.numberAssignments: { [sid]: organizationId }`, audited (`telephony.number_assigned`). `applyNumberSync` and the script import and repoint **only** sid→org pairs in that map. A number with no assignment shows as `unassigned` and is never imported.

**Preview masking.** The platform owner sees full E.164s. Any other viewer sees full numbers only for rows their own org owns; everything else shows `•••-•••-1234`.

**For each Twilio number, by `e164`:**
- **No row, or a RELEASED row, and assigned to the target org** → `new`. When chosen: upsert into that org as ACTIVE, with `provider: 'twilio'`, `providerSid`, `providerAccountSid`, capabilities, `importedAt = now`, `routing: VOICEMAIL_ONLY`, `ringBrowsers: null`, `billingMode` from the wallet, `monthlyCostCents` from `quoteNumber(kind)`, `nextRenewalAt = now + 1 month`. **No purchase charge.** It becomes primary only if the org has none. It can't be caller ID until a manager sets its routing (§2.4).
- **Row in the target org** → `here`. Refresh `providerSid`, `providerAccountSid` and capabilities.
- **Row in another org** → `other-account`. **Never changed or moved**; reported, named only for the platform owner.
- **Not in the assignment map** (platform account) → `unassigned`. Never imported.
- **Repoint is opt-in per number.** It is pre-ticked only when the current voice URL is empty or already on `APP_URL`'s host. A number pointing at any other host shows that host and stays unticked. Repoint sets VoiceUrl, StatusCallback, SmsUrl and VoiceFallbackUrl from `webhooksFor()`.
- Toll-free or local is inferred from the number (8xx = TOLL_FREE).
- Everything runs in one transaction per number; the audit entry is `telephony.number_imported` / `telephony.number_repointed`.
- Running it twice changes nothing the second time (idempotent).

---

## 5. Data model: one additive migration

`prisma/migrations/20261008120000_telephony_live/migration.sql` (the 34th migration; `20261007120000` is Dakota's `meta_lead_attribution`). Generate it locally with `npx prisma migrate dev --create-only --name telephony_live` against `prodigyflo_orient_test`, then rename the folder to this timestamp if needed. Read the SQL and confirm it has only `CREATE TYPE`, `CREATE TABLE`, `ALTER TABLE … ADD COLUMN` (nullable) and `CREATE INDEX` / `CREATE UNIQUE INDEX` on new columns. No drops, renames or `NOT NULL` on existing tables, and no change to `CallCenterSuppression`'s existing unique.

```prisma
enum VoiceCallDirection {
  INBOUND
  OUTBOUND
}

/// One row per ROOT carrier call (inbound PSTN parent, or the browser leg of an
/// outbound call). Child legs update it. Every write is idempotent on callSid.
model VoiceCall {
  id                       String             @id @default(cuid())
  organizationId           String
  callSid                  String             @unique
  childCallSid             String?
  accountSid               String
  direction                VoiceCallDirection
  /// 'servicing' | 'marketing' (outbound only)
  purpose                  String?
  /// 'greeting' | 'browser' | 'forward' | 'team' | 'bridged' | 'voicemail' | 'done'
  /// Lets the voice-limited count see which inbound calls hold an outbound leg.
  stage                    String?
  /// Our line: the dialled number (inbound) or the caller ID (outbound).
  phoneNumberId            String?
  lineE164                 String?
  remoteHash               String?
  remoteLast4              String?            @db.VarChar(4)
  /// encryptSecret blob of the other party's E.164 (so an unknown caller can be called back).
  remoteSecret             Json?
  clientId                 String?
  communicationId          String?            @unique
  callCenterLeadId         String?
  /// Rep who placed or answered it.
  userId                   String?
  /// 'browser:<userId>' | 'forward' | 'team:<userId>' | 'voicemail'
  answeredBy               String?
  /// initiated | ringing | in-progress | completed | busy | no-answer | failed | canceled | unknown
  status                   String             @default("initiated")
  outcome                  CallOutcome?
  startedAt                DateTime           @default(now())
  answeredAt               DateTime?
  endedAt                  DateTime?
  durationSeconds          Int?
  talkSeconds              Int?
  /// Twilio RecordingSid only (^RE[0-9a-f]{32}$). The media URL is never stored.
  recordingSid             String?
  recordingDurationSeconds Int?
  /// 'call' | 'voicemail'
  recordingKind            String?
  /// Recording was on for this call, so the sweep can recover a lost callback.
  recordingExpected        Boolean?
  /// When Twilio fetched the whisper notice. "Sent to the call", not "heard".
  disclosureServedAt       DateTime?
  /// Nonce of the hours override used for this call. Unique, so a token can't be reused.
  overrideNonce            String?            @unique
  needsAction              Boolean            @default(false)
  handledAt                DateTime?
  handledById              String?
  handledNote              String?
  errorCode                String?
  /// Compliance basis for outbound ("Consent on file (form 1234, Oct 2)") or the override note.
  basis                    String?
  createdAt                DateTime           @default(now())
  updatedAt                DateTime           @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId, needsAction, startedAt])
  @@index([organizationId, startedAt])
  @@index([remoteHash])
  @@index([clientId])
  @@index([callCenterLeadId])
  @@index([accountSid, status, startedAt])
}

/// Which signed-in users can take a browser call right now, per organization.
/// Heartbeat-based (no sockets on Vercel).
model VoicePresence {
  userId         String
  organizationId String
  /// pf_<organizationId>_<userId>
  identity       String
  /// 'ready' | 'offline'
  state          String
  lastSeenAt     DateTime

  @@id([userId, organizationId])
  @@index([organizationId, lastSeenAt])
}

/// What we last learned about a Twilio account. One row per account SID (not secret).
model TelephonyAccountState {
  accountSid         String    @id
  /// 'auto' | 'on' | 'off'
  voiceLimitedMode   String    @default("auto")
  voiceLimitedSeenAt DateTime?
  profileStatus      String?
  /// 'twilio' | 'manual'
  profileSource      String?
  balance            String?
  balanceCurrency    String?
  /// 'on' | 'off' | 'unknown' — Twilio "Enforce HTTP Basic Auth on media URLs"
  mediaAuthState     String?
  /// 'probe' | 'manual'
  mediaAuthSource    String?
  mediaAuthCheckedAt DateTime?
  lastCheckedAt      DateTime?
  lastError          String?
  updatedById        String?
  updatedAt          DateTime  @updatedAt
}
```

A2P status is per Messaging Service, so it lives in each org's `settings.telephony.a2p`, not on the account row.

Nullable columns and indexes on existing tables:

```prisma
model PhoneNumber {
  // …existing…
  providerAccountSid String?
  importedAt         DateTime?
  webhookCheckedAt   DateTime?
  /// { voiceUrl, smsUrl, statusCallback, voiceFallbackUrl } as found at Twilio when they differ from ours.
  webhookDrift       Json?
  /// null = ring browsers unless routing is VOICEMAIL_ONLY. See ringsBrowsers().
  ringBrowsers       Boolean?
}

model Communication {
  // …existing…
  @@index([externalRef])
}

model Message {
  // …existing…
  providerStatus   String?
  providerStatusAt DateTime?
}

model CallCenterLead {
  // …existing (incl. Dakota's leadAttribution / outOfArea)…
  /// HMAC of the E.164 with PHONE_HASH_KEY.
  phoneHash          String?
  consentAt          DateTime?
  /// 'lead_form' | 'inbound_inquiry' | 'manual'
  consentSource      String?
  consentTextVersion String?
  /// Meta form id the consent text belongs to (copied from leadAttribution.formId at ingest).
  consentFormId      String?
  consentNote        String?
  /// Set by a STOP from this number. Revoked consent counts as no consent.
  consentRevokedAt   DateTime?
  /// IANA zone set by staff ("they told us they're in X"). Audited.
  timeZone           String?
  @@index([organizationId, phoneHash])
}

/// Still one row per (organizationId, numberHash) — the existing unique stays.
model CallCenterSuppression {
  // …existing (organizationId, numberHash, reason)…
  last4             String?   @db.VarChar(4)
  smsBlockedAt      DateTime?
  /// 'sms_stop' | 'sms_stop_review' | 'manual' | 'call_center' | 'import'
  smsBlockedSource  String?
  callBlockedAt     DateTime?
  /// 'manual' | 'call_center' | 'import' | 'sms_stop' (only if the owner turns that on, §10)
  callBlockedSource String?
  note              String?
  createdById       String?
  removedAt         DateTime?
  removedById       String?
}
```

There is no `CallCenterLead.state`: the state comes from `leadAttribution.state` (§2.13). There is no `channel` column on suppressions: STOP sets the SMS pair, "Do not call" sets the call pair (and the SMS pair), START clears only `smsBlockedAt` where the source is `sms_stop`, and `evaluateOutbound` reads the column for its channel. A row with both pairs null is "no block" when `removedAt` is set and "block both" (legacy) when it isn't. A removed row is revived by update (clear `removedAt`, set the pair), not duplicated.

`Organization` gets the back-relation `voiceCalls VoiceCall[]` (schema only, no SQL).

Account settings live in `Organization.settings.telephony` and are written only through `mergeOrgSettings(orgId, 'telephony', patch)`:

```ts
{ recordOutbound?: boolean
  callWindow?: { start: number; end: number }
  businessHours?: { days: number[]; start: string; end: string } | null
  consentForms?: Record<string /* Meta formId */, string /* consent text version */>
  teamNumbers?: { hash: string; last4: string; label: string; addedById: string; addedAt: string }[]
  messagingServiceSid?: string | null
  a2p?: { status: string; source: 'twilio' | 'manual'; checkedAt: string } | null
  // platform org only:
  numberAssignments?: Record<string /* PN sid */, string /* organizationId */> }
```

---

## 6. UI package

Owns `src/app/(app)/**`, `src/components/**`, `src/lib/**/ui/**`, and `package.json` (adds `"@twilio/voice-sdk": "2.18.5"`, exact pin). It imports only types and the pure helpers named in §3, plus the server actions.

### 6.1 New components

| File | Phase | What |
|---|---|---|
| `src/components/voice/voice-provider.tsx` | P0b | `'use client'` context. Loads `@twilio/voice-sdk` with a **dynamic `import()` on first need** (keeps 179 KB out of every page). One `Device` per tab. Registers for incoming only in the **leader tab** (BroadcastChannel `pf-voice` + localStorage heartbeat); other tabs show "Calls ring in your other tab." Token from `getVoiceToken`, refreshed on `tokenWillExpire`. Presence: `fetch('/api/voice/presence', { method: 'POST' })` every 60 s while registered; `navigator.sendBeacon` with `offline` on `pagehide`. Exposes `call(target, lineId?, override?)`, `hangup()`, `mute()`, `sendDigits()`, `state`. |
| `src/components/voice/voice-dock.tsx` | P0b | Small fixed bar (bottom right; full-width bottom sheet under 640 px). Shows who, the timer, mute, keypad, hang up, line picker (only when `canPickLine`), a "One call at a time" chip when `voiceLimited`, and the last error in plain words. |
| `src/components/voice/call-button.tsx` | P0a/P0b | `target` prop. Runs `checkDial` → on `ok` connects with `ConnectParams` (P0b) or opens the `tel:` link (P0a / voice not ready); on block shows `reason`. `canOverride === 'hours'` (admins only) asks for a reason and re-checks with `override`. It never dials around a block. |
| `src/components/voice/incoming-call.tsx` | P0b | Banner with `pfCaller`, `pfLine`, Accept / Decline; a link to the client or lead from `pfTarget`. |
| `src/components/voice/audio-settings.tsx` | P0b | Mic and speaker pickers (resolve "default"/"communications" to real devices by label). Choices are kept per viewer in localStorage (wrapped in try/catch). The mic is taken at call start and released on hang-up: never hold the input device between calls, and never clear it mid-call. |
| `src/components/voice/recording-player.tsx` | P0a | `<audio controls preload="none" src=...>` plus the duration. Used in timelines and the missed list. |
| `src/components/telephony/twilio-status-card.tsx` | P0a | Renders `TwilioStatusVM`. Refresh button. Voice-limit mode switch and manual profile / A2P / media-auth entry only when `canChange`. Media auth row: "On", "Off — recordings are public at Twilio", or "Not checked yet". Env list (platform scope only) shows names with set/missing, never values. |
| `src/components/telephony/sync-numbers-dialog.tsx` | P0a | Platform owner: preview table with an org picker per number (assignment) → tick import / point-here → apply → result summary. Rows on another account are greyed with "Not changed."; `unassigned` rows say "Assign to an account first." |
| `src/components/telephony/calling-rules-card.tsx` | P0a | Outbound recording (switch, disabled while media auth is off; copy: "Callers hear 'This call may be recorded' when they answer."), calling window (start/end selects bounded to 8–21), one line: "Calls and texts need consent on file. Marketing calls skip Sundays and federal holidays." Consent forms list (form id → text version). Team numbers list (last 4 + label). |
| `src/components/telephony/dnc-list-card.tsx` | P0a | Add a number (phone, block texts / block calls, reason). The list shows last 4, what's blocked, reason, source and date. "Possible opt-out" rows show Confirm / Lift. Remove (managers, with a note). |
| `src/components/telephony/missed-calls.tsx` | P0a | List of `MissedCallVM`: time, line, caller, reason, voicemail player, "Call back" (`CallButton` with the target or `{ kind:'missed', id }`), "Mark handled" with an optional note. |
| `src/components/telephony/contact-timezone.tsx` | P0a | Shown with `UNKNOWN_TIMEZONE`: zone picker + note → `setContactTimeZone`. |

### 6.2 Edited pages and components

| File | Change |
|---|---|
| `src/app/(app)/layout.tsx` | Server-side `getVoiceSetup()`. When `ready`, wrap children in `VoiceProvider` and mount `VoiceDock` + `IncomingCall`. When not ready (including flag off), nothing loads. |
| `src/components/call-center/call-center.tsx` | "Call" → `CallButton({ kind:'lead', id })` (checks first in both phases; browser call when voice is ready, else `tel:` after the check). Real `RecordingPlayer` instead of the fake `Recording`. New "Missed" tab with a count badge (`MissedCalls`). The preview banner shows only when voice isn't ready. For SUPER_ADMIN, a "Phone setup" sheet holds the status card, sync (platform owner), calling rules and DNC list (this is how the owner reaches them while `PRODIGYFLO_FINAL_DESK` hides Settings). "Text" stays honest: "Texting leads isn't live yet." |
| `src/app/(app)/call-center/page.tsx` | Loads `VoiceSetup`, missed calls and (for managers) the status VM. `?missed=<id>` opens that row. |
| `src/components/client/client-header.tsx` | "Call" (`CallButton({ kind:'client', id })`) next to Log call. |
| `src/components/client/communications-tab.tsx`, `timeline-tab.tsx` | Call rows with a recording show `RecordingPlayer` (src `/api/voice/recordings/<voiceCallId>`). SMS rows use `smsStatusLabel`. Whisper rows say "Notice sent to the call". |
| `src/lib/messaging/ui/composer.tsx` | A2P warning chip (§2.9). Shows `OUTSIDE_HOURS` / `SUPPRESSED` / `OPTED_OUT` reasons as returned. |
| `src/app/(app)/settings/phone-numbers/page.tsx`, `numbers-console.tsx` | Status card on top; "Sync numbers from Twilio" button (platform owner, or vault-account managers); calling rules and DNC list cards. Rows show "Imported", webhook drift ("Points elsewhere: host"), a "Ring browsers" switch, and "Can't take callbacks" when the line can't be caller ID. |

### 6.3 Copy (plain, short)

- Not set up: "Phone calling isn't set up yet."
- Flag off: "Phone calling from the browser isn't switched on yet."
- Mock: "Test mode. No real calls are placed."
- Blocks: use `reason` from the server exactly as given.
- Voice limited: "One call at a time until Twilio approves the business profile."
- SMS: "Delivered", "Accepted by carrier", "Blocked: texting registration pending", "Failed: <meaning>".
- Recording notice: "Notice sent to the call" (never "played" or "heard").

---

## 7. Environment variables

Existing variables, now required in production:

| Name | Meaning |
|---|---|
| `TELEPHONY_PROVIDER` | `twilio` in production (`mock` everywhere else). |
| `SMS_PROVIDER` | `twilio` in production. |
| `TWILIO_ACCOUNT_SID` | The "ProdigyFlo Platform" subaccount SID. |
| `TWILIO_AUTH_TOKEN` | That subaccount's auth token. Used for REST and webhook signatures. |
| `APP_URL` | `https://www.prodigyflo.ai`. It must equal the host given to Twilio; the apex redirects. |
| `VAULT_KEY` | As today. **No longer** keys `phoneHash`. |
| `CRON_SECRET` / `JOBS_TOKEN` | As today (sweep rides `/api/jobs/run`). |

New variables:

| Name | Phase | Meaning |
|---|---|---|
| `PHONE_HASH_KEY` | P0a, required | 32+ random bytes (hex). Keys `phoneHash`. **Never rotated** (§2.7). Missing → every outbound check fails closed with `CHECK_FAILED`. |
| `TELEPHONY_OVERRIDE_KEY` | P0a, required | 32+ random bytes (hex). Signs hours-override tokens. Rotating it only invalidates tokens younger than 2 minutes. |
| `TELEPHONY_PLATFORM_ORG_ID` | P0a, required | Organization id of ProdigyFlo LLC's own workspace. Its SUPER_ADMINs are the platform owners (§2.1). |
| `TWILIO_VOICE_FALLBACK_URL` | P0a, recommended | URL of a Twilio-hosted TwiML Bin played when the app can't answer. |
| `TELEPHONY_WEBHOOK_HOSTS` | P0a, optional | Comma list of extra hosts accepted when checking signatures (e.g. a preview host). Default: only `APP_URL`'s host. |
| `VOICE_BROWSER_ENABLED` | P0b | `true` turns on browser calling. Default and production value until §9 step 11(e) passes: unset / `false`. |
| `TWILIO_API_KEY_SID` | P0b | API key (Standard) created **in the subaccount**. It signs Voice access tokens. |
| `TWILIO_API_KEY_SECRET` | P0b | Its secret. Never logged; shown once by Twilio. |
| `TWILIO_TWIML_APP_SID` | P0b | The TwiML App whose Voice URL is `/api/telephony/client/voice`. |

Removed from the plan: `TWILIO_MESSAGING_SERVICE_SID` (Messaging Services are per org, §2.9).

Kept, with tightened meaning: `TELEPHONY_ALLOW_UNSIGNED_WEBHOOKS` works only in local dev with the mock provider and must be **unset** in production. `TWILIO_FROM_NUMBER` is never used for an organization's text: texts go out only from the account's own SMS-capable line on the sending account, or the send fails with "This account has no texting line yet."

Read, not changed: `META_FIXTURE_LEADS` must be unset in production (Dakota's fixture mode already refuses production hosts; §2.13 relies on it).

Check (do not change without the owner): `PRODIGYFLO_FINAL_DESK` and `PRODIGYFLO_MAINTENANCE` (§10).

---

## 8. Test plan

All tests run locally against `prodigyflo_orient_test`. No network: Twilio is `vi.stubGlobal('fetch', …)`. Signed requests use `computeTwilioSignature(testToken, url, params)` with `APP_URL`, `TWILIO_AUTH_TOKEN`, `PHONE_HASH_KEY`, `TELEPHONY_OVERRIDE_KEY` and `TELEPHONY_PLATFORM_ORG_ID` stubbed through `vi.stubEnv`.

### 8.1 Pure unit tests (`src/lib/telephony/*.test.ts`)

- `access-token.test.ts`: decoded header and payload equal `tests/fixtures/twilio-access-token.json` field by field (`cty`, `iss`, `sub`, `jti`, `grants.identity`, `grants.voice.outgoing.application_sid`, `grants.voice.incoming.allow`), TTL, signature verifies with the secret, identity round-trip including the org id.
- `compliance.test.ts`: every precedence row of §2.7, in order. An opt-out beats consent and servicing; own line and team-number allow; **a rep's profile phone set to a lead's number still gives `NO_CONSENT`**; servicing client with no `TCPA_CONTACT` is callable, suppressed servicing client is not, intake-stage client is marketing; `inbound_inquiry` day 89 allowed, day 91 blocked; `lead_form` with no expiry; `consentRevokedAt` → `NO_CONSENT`; no override path for `NO_CONSENT`; the override token (valid, expired, wrong user, wrong org, wrong target, wrong line, wrong code, reused nonce); override refused past 21:00 and for `UNKNOWN_TIMEZONE`; **a suppression written under one `VAULT_KEY` still blocks after `VAULT_KEY` changes**; fail-closed on a loader error and on a missing `PHONE_HASH_KEY`.
- `timezones.test.ts`: a single-zone prefix, a multi-zone prefix (must pass in all zones), non-geographic → unknown, union of hints (area code says Pacific, attribution state says Eastern → both must pass), window edges at 7:59/8:00/19:59/20:00, DST days, a marketing call on a Sunday and on each federal holiday refused, a servicing call on a Sunday allowed, `STATE_WINDOWS` overrides narrow but never widen. A checksum test asserts the data file's recorded SHA-256 and commit fields are present and the entry count matches.
- `carrier-errors.test.ts`: every listed code, the unknown-code fallback, and `smsStatusLabel` for each status.
- `signature.test.ts` (extend `telephony.test.ts`): candidate URLs (APP_URL, an allowlisted forwarded host, a non-allowlisted host rejected); `allowUnsignedWebhooks()` false under `VERCEL_ENV=production`, under `NODE_ENV=production`, and with the twilio provider.
- `twiml.test.ts` (extend): browser stage with ≤ 5 clients + params and `pf_<org>_<user>` identities, exactly one client when limited, TEAM one number per step, outbound dial (record + whisper only when on), and XML escaping of every value.
- `recording-media.test.ts`: bad SID → no fetch; account mismatch → no fetch; URL built only from `VoiceCall.accountSid`; `Range` forwarded; redirect to a non-allowlisted host refused; Authorization never sent after a redirect.
- `twilio` builders: list (+ paging), update webhooks, balance, message fetch, call fetch, call recordings, profile, A2P per service, purchase with fallback, SMS send with `MessagingServiceSid` **and** `From`; mappers against recorded-shape fixtures.
- `consent.test.ts` (extend): new STOP words, START, whole-message rule, `isRevocationText` ("please stop texting me" → true; "don't stop the project" → true, held for review by design).

### 8.2 DB-backed tests (`tests/telephony-*.test.ts`)

Route tests call the exported `POST`/`GET` with a signed `Request`. `after()` needs a live request scope, so use the existing pattern from `tests/meta-webhook-attribution.test.ts`: `vi.mock('next/server', …)` that replaces `after` with a function capturing the callbacks, then await them in the test before asserting.

- `telephony-webhooks.test.ts`: every `/api/telephony/**` route. A bad signature gets 403 with no DB write; an **unsigned request for an unknown number gets 403, not `rejectTwiml`**; a signed request for an unknown number gets the "unknown" answer; a wrong `AccountSid` gets 403; the happy path; a replayed callback (idempotent); a replayed `client/voice` returns the same TwiML and no 500.
- `telephony-inbound-flow.test.ts`: answered by browser; unanswered → TEAM step 1 → step 2 → voicemail; caller hangs up while ringing → missed; status `completed` after voicemail keeps VOICEMAIL (regression for 5a); unknown caller → `VoiceCall` with recording + an INBOUND lead (regression for 5c); unknown caller whose number matches an existing Meta lead (10-digit phone, backfilled hash) reuses that lead; voice limited → one client leg; voice limited with an active outbound call → straight to voicemail; a user present in org A only is never offered org B's call; `RecordingUrl` is never persisted (`Call.recordingRef` is the internal path).
- `telephony-outbound-flow.test.ts` (P0b): `client/voice` for a client in scope; out of scope; a lead locked by someone else; suppressed; no consent; outside hours with and without an admin override token; a reused override token; voice limited with another active call in either direction; two concurrent `client/voice` requests under the limit → exactly one passes; a rep using another rep's line is refused; a voicemail-only line is refused as caller ID; the Communication + Call rows; finalize ≥ 20 s sets `firstContactAt`; 10004 sets `voiceLimitedSeenAt`; `?parent=1` finalizes the root.
- `telephony-recordings.test.ts`: the playback route as the owner, as the rep who placed the call, as another CLOSER out of scope (404), signed out (401), `?original=1` as a rep (404), a `Range` request returns 206 with `Content-Range`, a bad stored SID → 404 with no fetch.
- `telephony-sync.test.ts`: **org A's SUPER_ADMIN previews and applies on the platform account → refused, sees no rows; a platform number assigned to org B is not shown in full to A and is not imported or repointed**; platform owner: new / here / other-account / released-here / unassigned; only assigned pairs import; the second run is a no-op; repoint is default-off for a foreign host; no charge on import; vault-account admin syncs their own account; the script function in dry-run writes nothing.
- `telephony-status.test.ts`: org A's viewer on the platform account sees only A's numbers and errors, no balance, no env, `canChange: false`; A's SUPER_ADMIN can't call `setVoiceLimitedMode`; the platform owner can.
- `telephony-sms-status.test.ts`: callback transitions (forward-only); the sweep fetches stale SENT; 30034 is stored and labelled; STOP matched and unmatched → `smsBlockedAt` + lead `consentRevokedAt`; a number with both a STOP and a "Do not call" keeps both blocks; START clears only `sms_stop` and leaves the call block; "please stop texting me" → `sms_stop_review` hold + notification; STOP doesn't create an inbound inquiry; `sendMessage` refuses suppressed and outside hours but allows the reply window; per-org Messaging Service sends `MessagingServiceSid` + that org's `From`; automation deferral doesn't count an attempt.
- `telephony-meta-leads.test.ts`: a Meta lead from a form in `consentForms` gets `phoneHash`, `consentAt`, `consentFormId`; a form not in the map gets no consent; a fixture-mode lead gets no consent; Dakota's `leadAttribution` / `outOfArea` are unchanged; the callee zone comes from `leadAttribution.state`; a 10-digit lead is dialable and dedupes against an inbound call from `+1` of the same number.
- `telephony-backfill.test.ts`: dry run writes nothing; execute sets `phoneHash` on bare-digit phones; second run is a no-op.
- `telephony-credentials.test.ts` (extend): an unreadable vault row refuses instead of falling back to env; a vault row with only a SID refuses.
- `telephony-sweep.test.ts`: runs under `PRODIGYFLO_FINAL_DESK=true`; a call active > 15 min gets its status fetched; a stale call whose fetch fails → `unknown` after 4 h; a lost recording is recovered; every fetch has a timeout; the budget is respected; it never throws.
- `final-desk/routes.test.ts`: the CLOSER `/api/voice/...` assertions.

### 8.3 Gates (all must pass; capture the logs)

1. `npx prisma generate`; `npx prisma migrate deploy` against the **local** test DB; then read the SQL for additive-only.
2. `npm test`: all green. Baseline on `0b03c61` after `npx prisma generate` and `migrate deploy` (33 migrations): **123 files / 1239 tests passing** (measured 2026-10-08).
3. `npx next typegen && npm run typecheck`: 0 errors (typegen first, or the missing Next globals fail it).
4. `npm run lint`: 0 errors. The one existing warning is acceptable; no new warnings.
5. `npm run build`: exit 0 with `DATABASE_URL` set (it need not be reachable). Check that the voice SDK is not in the shared first-load chunk.
6. Grep checks:
   - no `TWILIO_AUTH_TOKEN` / `TWILIO_API_KEY_SECRET` / `PHONE_HASH_KEY` / `TELEPHONY_OVERRIDE_KEY` value or token string in any `console.*` or audit payload
   - no `RecordingUrl` written to the database anywhere (`rg "RecordingUrl" src` shows reads only, inside the recording routes, never in a `data:` object)
   - no `User.phone` / `user.phone` read in `src/lib/telephony/compliance.ts`
   - no other business's names, numbers or keys anywhere in the diff
   - no `TELEPHONY_ALLOW_UNSIGNED_WEBHOOKS` path reachable in production code
   - no new state normalizer (`rg "STATE_NAMES|normalizeState" src/lib/telephony` finds only imports from `@/lib/meta/attribution`)

---

## 9. Live setup the DA must do (after review; not part of the build)

Final names, checked against the code on `feat/telephony-live` (integration, 2026-10-08). Every variable below is read by the app; nothing else is needed. All Twilio work happens **in the "ProdigyFlo Platform" subaccount**, never the parent.

### 9.1 Vercel env (project prodigyflo-42, Production)

| Name | Value | When |
|---|---|---|
| `TELEPHONY_PROVIDER` | `twilio` | P0a |
| `SMS_PROVIDER` | `twilio` | P0a |
| `TWILIO_ACCOUNT_SID` | the subaccount SID (`AC…`) | P0a |
| `TWILIO_AUTH_TOKEN` | the subaccount auth token (REST + webhook signatures) | P0a |
| `APP_URL` | `https://www.prodigyflo.ai` (exactly the host given to Twilio) | P0a, check |
| `PHONE_HASH_KEY` | `openssl rand -hex 32`, fresh; copy to the owner's secret store; **never rotate** | P0a |
| `TELEPHONY_OVERRIDE_KEY` | `openssl rand -hex 32`, fresh | P0a |
| `TELEPHONY_PLATFORM_ORG_ID` | the ProdigyFlo LLC workspace's `Organization.id` | P0a |
| `TWILIO_VOICE_FALLBACK_URL` | the TwiML Bin URL from step 5 | P0a, recommended |
| `TELEPHONY_WEBHOOK_HOSTS` | unset (only for a preview host that receives signed webhooks) | optional |
| `VOICE_BROWSER_ENABLED` | **unset** until step 12(e) passes, then `true` | P0b |
| `TWILIO_API_KEY_SID` | the Standard API key SID (`SK…`) from step 2 | P0b |
| `TWILIO_API_KEY_SECRET` | its secret (shown once) | P0b |
| `TWILIO_TWIML_APP_SID` | the TwiML App SID (`AP…`) from step 6 | P0b |
| `TWILIO_FROM_NUMBER` | **unset** (texts go out from the account's own line) | check |
| `TELEPHONY_ALLOW_UNSIGNED_WEBHOOKS` | **unset** (ignored in production anyway) | check |
| `META_FIXTURE_LEADS` | **unset** | check |
| `VAULT_KEY`, `CRON_SECRET`, `JOBS_TOKEN` | as today | unchanged |

The status card (Call Center → Phone setup, platform owner) lists which of these are set, by name only.

### 9.2 Steps, in order

1. **Twilio subaccount "ProdigyFlo Platform":** confirm its SID matches `TWILIO_ACCOUNT_SID`. Never use the parent account in this app.
2. **API key (P0b):** in the subaccount, Account → API keys → create a **Standard** key named "ProdigyFlo browser calling". Put the SID in `TWILIO_API_KEY_SID` and the secret in `TWILIO_API_KEY_SECRET`. The secret is shown once.
3. **Numbers:** ProdigyFlo's lines live in the subaccount (moved 2026-10-07). Buy any new ProdigyFlo number in the subaccount. Nothing belonging to any other business goes into it.
4. **Media auth, before any recording:** in the subaccount, Voice → Settings → General → turn on "Enforce HTTP Basic Auth on media URLs" (confirm the exact menu path in the console). Then record it on the status card as "I turned it on in Twilio".
5. **Fallback TwiML Bin (in the subaccount):** a short `<Say>` ("We can't take your call right now. Please leave a message after the tone.") + `<Record maxLength="120"/>`. Its URL goes in `TWILIO_VOICE_FALLBACK_URL`.
6. **TwiML App (in the subaccount, P0b):** "ProdigyFlo Browser Calling". Voice URL `https://www.prodigyflo.ai/api/telephony/client/voice` (POST); Voice fallback URL = the Bin; **Status Callback URL `https://www.prodigyflo.ai/api/telephony/client/status?parent=1`** (POST). Its SID goes in `TWILIO_TWIML_APP_SID`.
7. **Vercel env:** set §9.1. Leave `VOICE_BROWSER_ENABLED` unset. Read the current `PRODIGYFLO_FINAL_DESK` and `PRODIGYFLO_MAINTENANCE` values and tell the owner. Maintenance mode drops Twilio status and recording callbacks; the sweep reconciles them afterwards (§2.11).
8. **Migrate, then backfill** (production `DATABASE_URL`, **before** the deploy):
   - `npx prisma migrate deploy` (adds `20261008120000_telephony_live`, `20261008180000_telephony_review_fixes` and `20261008200000_sequence_enrollment_attempts`; additive only: nullable `VoiceCall.stirVerstat`, `Client.timeZone`, `CallCenterEvent.voiceCallId`, `SequenceEnrollment.attempts` and a unique index on `CallCenterEvent (voiceCallId, type)`).
   - `npx tsx scripts/telephony-backfill-phone-hash.ts` (dry run), then `npx tsx scripts/telephony-backfill-phone-hash.ts --execute`. It needs `PHONE_HASH_KEY` set to the **same** value as Vercel.
9. **Deploy:** PR `feat/telephony-live` into `main` on Dakota's repo; Vercel builds `main`. The lockfile adds `@twilio/voice-sdk@2.18.5`. The owner decides when. The sweep needs no new cron: it rides the existing `*/5` `/api/jobs/run` entry in `vercel.json`.
10. **Facebook, read-only:** `node tools/meta.mjs status`, `node tools/meta.mjs check-token`, `node tools/meta.mjs check-subscription` with production env. Confirm the Page is subscribed to leadgen and note each live form id. No `subscribe`, no `test-lead` against production.
11. **Account settings:** as platform owner, assign each platform number to its organization (Call Center → Phone setup → Sync numbers), then sync: dry run `npx tsx scripts/telephony-sync-numbers.ts`, then `--execute --repoint` for the numbers that should point here (or the Sync dialog). `--repoint` only touches numbers that point nowhere or already at `APP_URL`. Then per org: routing per line (imported lines are voicemail-only and can't be caller ID until their routing reaches a person), "Rings browsers" per line (P0b), calling rules (window, outbound recording), team numbers, the Messaging Service once A2P exists, and consent forms — **only** for forms whose text really carries the consent language, with that text's version.
12. **Verify live, in this order:**
    - (a) An unsigned POST to `https://www.prodigyflo.ai/api/telephony/voice` gets **403**, both for a real line and for a made-up `To`.
    - (b) The status card (platform owner) shows the subaccount, the balance, the number count, profile/A2P state, media auth "On" and "One call at a time" (expected while the profile is pending). A non-platform SUPER_ADMIN sees only their own numbers.
    - (c) Call the main line from a cell with nobody signed in: routing/voicemail as configured; leave a voicemail. It appears under Missed, plays (scrub forward to check 206), and "Mark handled" clears it.
    - (d) From Call Center, "Call" your own cell (add it to Team numbers first): the check passes and the `tel:` link opens. Add your cell to the DNC list and try again: refused with the reason. Remove it. As a manager, "Call back" on a missed call from an unknown number opens `tel:` (the check returns the number to `telephony:manage` only).
    - (e) **P0b smoke test.** Set `VOICE_BROWSER_ENABLED=true` on a preview first if possible, else production during a quiet hour. Sign in, open Call Center, allow the mic; call the main line from a cell: the browser rings, answer, talk 30 s, the call shows in the timeline. Call your own cell from the dock: caller ID shows the account line. If recording is on, the notice plays on answer and the recording plays back on iPhone Safari too; note the redirect host the recording fetch hit, and narrow the allowlist (§2.6, TODO in `recording-media.ts`). If any of this fails, set the flag back off; P0a keeps running.
    - (f) Text a consented test client: the status shows "Blocked: texting registration pending" (30034) until A2P is approved. Never "Delivered".
    - (g) Twilio console → Monitor → Errors: no 11200/12100 webhook errors from the tests.
13. **Rollback:** redeploy the previous build. The existing number webhooks keep the same paths, so inbound keeps working. Browser calling goes away by unsetting `VOICE_BROWSER_ENABLED`, without a redeploy of code. The migration is additive and stays.

---

## 10. Decisions the owner should know about

- **Strict DNC is the only mode.** Marketing calls and texts need consent on file: a signed `TCPA_CONTACT`, a Facebook form that you've marked as carrying the consent text, consent a manager recorded with where the signed copy is kept, or an inbound call or text in the last 90 days. A rep's own say-so is not enough. The registry scrub is P1.
- **Active clients are servicing calls** and don't need consent: status active/on hold in the fulfillment or submission stages, or closed-won in the last 18 months. Intake, qualification and sales-stage clients are treated as leads. Please confirm this stage mapping with counsel.
- **Calling window** is 8:00–20:00 callee-local. Marketing calls and texts also skip Sundays and federal holidays until counsel fills the per-state table. An admin can stretch a narrowed window up to 21:00 with a reason, never past it, and never when we don't know the person's time zone.
- **Recording:** inbound stays per line; outbound is off until an admin turns it on, and the notice always goes out when it's on. Twilio's media auth must be on first.
- **STOP** blocks texts and voids form consent for calls. It doesn't add a call block. The owner can ask for STOP to block calls too; it's a one-line change. A message that only *contains* "stop" holds texts to that number until an admin confirms or lifts it.
- **`PHONE_HASH_KEY` must never be rotated or lost.** Losing it silently empties the do-not-call list.
- **`PRODIGYFLO_FINAL_DESK=true`** still skips automation and renewals in the job runner; the new telephony sweep runs regardless. Settings → Phone numbers is hidden in that mode, so the owner's tools are also in Call Center → Phone setup.
- **Imported numbers** start monthly ledger rent from import day (ledger only for agency-card accounts). They start as voicemail-only and can't be used as caller ID until their routing reaches a person.
- **Voice limited:** until Twilio approves the business profile, one bridged call at a time across the whole subaccount (all orgs on it). An inbound call that arrives during another call goes to voicemail.
- **Shared subaccount:** only the platform owner (`TELEPHONY_PLATFORM_ORG_ID`) sees account-wide data and assigns numbers to organizations.
- **Multi-zone states give all their zones.** A lead whose state is NV also gets America/Denver (West Wendover), and AZ also gets Denver (Navajo DST), so Nevada leads stop being callable about 7–8 pm Pacific instead of 8 pm. One line in `src/lib/telephony/timezones.ts` (`STATE_ZONES`) if the owner wants Pacific only.

---

## 11. Platform notes (from the setup runs)

- Toolchain: Node 26.1, npm 11.13. `npm ci` works (its postinstall runs `prisma generate`).
- Local Postgres 16 runs as a Windows service on 127.0.0.1:5432 (postgres/postgres). The scratch DB `prodigyflo_orient_test` has all 33 migrations applied (Dakota's `20261007120000_meta_lead_attribution` applied 2026-10-08). A gitignored `.env` holds local-only values. Never point tests at `prodigyflo_dev`.
- After pulling `main`, run `npx prisma generate` before typecheck or tests (the client must know `leadAttribution` / `outOfArea`).
- Vitest runs with `fileParallelism: false` (shared DB). `server-only` is stubbed under Vitest.
- `typecheck` needs `npx next typegen` first on a fresh tree.
- `@twilio/voice-sdk@2.18.5` is in `package.json` (exact pin) and `package-lock.json`. In this repo's `next build` it lands in its own ~179 KB chunk, loaded only by the voice provider's dynamic `import()`; it is in no `rootMainFiles` list and no page's first-load files (checked 2026-10-08).
- `npm run e2e` (Playwright, synthetic workspace) does not read `.env`. Export it first (`set -a; . ./.env; set +a`) and run `npm run build` before it.
- When the migration was generated, Prisma also emitted drift that already exists on `main` (FK drop/re-add on `AppointmentReceipt`, `PropertyRecordsJob`, `RecordsAnalysisJob`; a drop of `ExternalDocumentImport_analysisPending_idx`). It was removed from `20261008120000_telephony_live`; investigate it separately with Dakota.
- The unmerged `origin/feat/call-center-desk` is an older parallel design. Do not merge it or copy from it.

---

## 12. Order of work

1. **P0a backend:** `voice-contract.ts` (§3) → migration + schema (§5) → pure libs with their tests (signature, compliance, timezones + generated data, carrier-errors, recording-media, TwiML, Twilio builders) → credentials + tenancy → webhook auth → inbound routes, ledger, sync, sweep, status, actions → messaging changes (STOP, status, per-org service) → Meta ingest wiring + backfill script → DB tests → gates.
2. **P0a UI** (once the contract file exists): status/sync/rules/DNC cards in the Phone setup sheet and Settings → Missed tab + recording player → `CallButton` with check + `tel:` → client header + timelines → composer chip.
3. **P0b** (after P0a's gates pass): access token + fixture → client routes → presence route → voice provider/dock/incoming/audio settings behind `getVoiceSetup` → outbound-flow tests → build check of chunk size.
4. **Integration:** run every gate in §8.3 on the combined tree with the flag both off and on; fix; hand back to the DA with the live steps in §9.

---

## 13. Review log (revision 2, 2026-10-08)

| # | Issue | Decision | Reason / where |
|---|---|---|---|
| 1 | Number sync can move numbers across tenants on the shared account (critical) | Accepted | Platform-account sync is platform-owner only, imports only an explicit sid→org assignment map, previews mask numbers the viewer's org doesn't own; per-org admins sync only their own vault account. Cross-tenant test added. §2.1, §4.4, §8.2. |
| 2 | DNC list doesn't survive a VAULT_KEY rotation (critical) | Accepted (first option) | Dedicated `PHONE_HASH_KEY`, never rotated, documented next to vault rotation; fails closed if missing. Test: suppression still blocks after `VAULT_KEY` changes. §2.7, §7, §8.1. |
| 3 | Per-channel suppression rows conflict with the existing unique (critical) | Accepted | One row per (org, number) with `smsBlockedAt/Source`, `callBlockedAt/Source`, `removedAt`; `channel` dropped; START clears only `sms_stop`. §2.10, §5. |
| 4 | Consent bypass through self-edited `User.phone` (critical) | Accepted | Step 5 is own `PhoneNumber` rows plus manager-kept, audited `teamNumbers`; `User.phone` never read; test and grep gate added. §2.7, §8. |
| 5 | Hours override can produce an unlawful call (high) | Accepted | Override only widens the narrowed account window up to 8–21 ∩ state/day rules in every zone; `UNKNOWN_TIMEZONE` never overridable (fix = audited `setContactTimeZone`); HMAC bound to org, user, target, line, code, exp, nonce; nonce unique on `VoiceCall`; `TELEPHONY_OVERRIDE_KEY`. §2.7, §5, §7. |
| 6 | Confirm-mode DNC is rep self-attestation (high) | Accepted | Confirm mode removed from P0; strict is the only mode; may return in P1 only with a registry file. §2.7, §3, §6, §10. |
| 7 | Servicing calls blocked like telemarketing (high) | Accepted with a change | `purpose` (servicing or marketing) added. There is no "case" or service-contract model in this repo (`Contract` is the homeowner's solar contract, and Meta leads also become `Client`s), so "active client" is defined by pipeline: FULFILLMENT/SUBMISSION stages, or CLOSED_WON within 18 months. Flagged for counsel. SMS keeps `getConsentDecision`. §2.7, §10. |
| 8 | Inbound-inquiry consent never expires; STOP counts as inquiry (high) | Accepted | Expiry by source (`inbound_inquiry` = 90 days); STOP/revocation texts and DNC calls excluded; day-91 and STOP tests. §2.7, §2.12, §8.1. |
| 9 | Recordings not private (high) | Accepted | §9 step 4 turns on media HTTP auth before any recording; status card probes it; only the SID is stored; `Call.recordingRef` = internal path; grep gate on `RecordingUrl`. §2.6, §8.3, §9. |
| 10 | Recording proxy SSRF / iOS / buffering (high) | Accepted | SID regex, URL from `VoiceCall.accountSid` with matching creds, manual redirects to an allowlist without auth, Range passthrough (206), streamed body; tests listed. Exact redirect host and mono-mix Range support marked unverified for the live check. §2.6, §8. |
| 11 | Voice-limited ignores inbound legs and races (high) | Accepted | Legs counted in both directions via `VoiceCall.stage`; advisory lock around count + insert; inbound goes to voicemail when busy; TwiML App status callback `?parent=1`; sweep fetches real status after 15 min. §2.5, §2.8, §2.11, §9. |
| 12 | Browser identity/presence not bound to an org (high) | Accepted | Identity `pf_<orgId>_<userId>`; `VoicePresence @@id([userId, organizationId])`; membership + permission re-checked in that org; cross-org test. §2.3, §2.5, §5. |
| 13 | Status card and voice-limit switch are account-wide on a shared account (high) | Accepted | Account-wide fields and switches only for the platform owner; others see their own numbers and errors. `TwilioStatusVM.scope`; cross-org test. §2.1, §2.8, §3. |
| 14 | One global Messaging Service breaks sender identity and A2P (high) | Accepted | Per-org `settings.telephony.messagingServiceSid`, sends `MessagingServiceSid` + `From`; A2P per service; global env var removed. §2.9, §7. |
| 15 | Plan doesn't reconcile with Dakota's `0b03c61` (high) | Accepted | `CallCenterLead.state` dropped (state from `leadAttribution.state` via `normalizeState`); migration renamed `20261008120000_telephony_live`; `phoneHash`/consent added inside his `create` data; consent keyed by `formId`; fixture leads never stamped; line refs, migration count (33) and test baseline (123 / 1239, measured) updated. §0, §2.13, §4.2, §5, §8.3, §11. |
| 16 | Phone normalization and hash backfill missing (high) | Accepted | `toE164` before every hash/dial/compare; idempotent dry-run-first backfill script, run by the DA after migrate; 10-digit dedupe test. §2.14, §9. |
| 17 | Hand-built area-code → zone table (medium) | Accepted | Vendored, generated from libphonenumber `map_data.txt` with source URL, commit and checksum; unknown when missing; hints unioned, window must hold in every zone. §2.7, §4.1, §8.1. |
| 18 | No day-of-week or holiday rules (medium) | Accepted | `STATE_WINDOWS` gains `days` / `holidays` / `source`; marketing default no Sundays and no federal holidays with a cited TODO; servicing keeps 8–20 daily. §2.7, §10. |
| 19 | STOP narrower than the FCC revocation rule (medium) | Accepted | Whole-message keywords automatic; a revocation word in a longer message holds sends (`sms_stop_review`) and asks an admin; STOP sets lead `consentRevokedAt`. §2.10. |
| 20 | Caller-ID callback honesty (medium) | Accepted | `PhoneNumber.ringBrowsers Boolean?` instead of changing VOICEMAIL_ONLY; `resolveCallerLine` refuses lines whose inbound path reaches no person. §2.4, §2.5, §5. |
| 21 | Webhook auth details (medium) | Accepted | Platform-token check before answering "unknown", else 403; credentials from one source, partial vault rows refuse; `client/voice` idempotent on `CallSid` with P2002 caught. §2.1, §2.2, §4.3. |
| 22 | Missing `externalRef` index; callbacks lost in maintenance (medium) | Accepted | `Communication(externalRef)` index in the same migration; sweep recovers recordings and final call status; maintenance note in §2.11 and §9. |
| 23 | Next 16 / Vercel mechanics (medium) | Accepted | `POST /api/voice/presence` with `sendBeacon` / `fetch` (server action removed); the `vi.mock('next/server')` `after` pattern named; `AbortSignal.timeout(5000)` and budget checks in the sweep. §2.11, §3, §8.2. |
| 24 | P0 too large to be "done" without live calls (medium) | Accepted | Split into P0a (live) and P0b (dark behind `VOICE_BROWSER_ENABLED`); token claim set pinned and compared with an offline twilio-node fixture. Revision 1 listed the claims in prose only. §1.1, §2.3, §12. |
| 25 | Facebook half of the request not covered (medium) | Accepted | Rows 42–43 and §2.13: Meta leads wired into dialing on top of Dakota's intake; Messenger out of scope; read-only Meta checks in §9 step 10. |
| 26 | `disclosurePlayed` overclaims (low) | Accepted | Renamed `disclosureServedAt` (DateTime); UI says "Notice sent to the call". §2.6, §5, §6.3. |

No issue was rejected.

---

## 14. Integration log (2026-10-08)

Combined tree on `feat/telephony-live` (base `0b03c61`), local only.

- `npm install` added `@twilio/voice-sdk@2.18.5` to the lockfile (5 packages).
- Contract change, additive: `DialCheck` (ok) gains `dial?: string`. `checkDial` returns it only in the `tel:` flow (no browser line) and only to `telephony:manage` holders, so a manager can call back a missed call from an unknown number. Everyone else still dials from a page that already shows the number. `CallButton` uses `tel` first, then `dial`. Tests: a rep never gets `dial`; a manager does.
- Checked and left as built: list actions return bare arrays or `{ ok:false }` (the UI reads both through `actionFailure`); `ringsBrowsers` / `takesCallbacks` take the `PhoneNumber` row; the A2P words the UI maps (`verified`, `pending`, `in_progress`, `failed`) match `parseA2pStatus`'s lowercased Twilio campaign status; `setRingBrowsersAction` (Settings → Phone numbers) is org-checked and audited.
- Gates (final tree): `npm run typecheck` 0 errors; `npm run lint` 0 errors, 1 existing warning; `npm test` all green; `npm run build` exit 0 (3 existing Turbopack warnings in `src/lib/deploy.ts`); `npm run e2e` 3/3; §8.3 grep gates clean.
