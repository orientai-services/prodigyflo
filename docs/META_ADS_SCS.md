# Meta Ads: SCS General 1 in ProdigyFlo (build contract)

Branch `feat/meta-ads-scs`, base **0b03c61** (main after PR #69, Dakota's "Meta intake: lead attribution, out-of-area flag, read-only fb checks"). Status: **revision 2, built and integrated on this branch (2026-10-08), not committed, not deployed.** Backend, UI and the integration pass are green locally (typecheck, lint, tests, build); see the Build log at the end. Revision 1 was written against 39bb0dc; the Review log at the end lists what changed and why.

Before any typecheck or test run: `npx prisma generate` (0b03c61 adds `Client.leadAttribution`, `CallCenterLead.leadAttribution` and `outOfArea`).

## 0. Goal and decisions

**Goal.** ProdigyFlo users in **one** organization see one Meta ad account, **SCS General 1 (`act_1742876583597558`)**, in a full ads dashboard with ProdigyFlo branding:

- account card, campaign → ad set → ad metrics and daily trends;
- billing (card on file, unpaid balance, a ledger of payments inferred from balance drops, status alerts);
- a spend cycle;
- a funnel by ad built from each lead's own `ad_id` (already stored by Dakota's intake code);
- an owner-visible connection status.

Every other ad account is invisible to every organization, including accounts in the same Meta business that a token might reach. Every other organization sees nothing from this account.

**Decisions:**

1. **The account is bound to exactly one organization.**
   - `META_ADS_ORG_ID` (an `Organization.id`, never a slug) plus `META_ALLOWED_AD_ACCOUNTS` (the positive allowlist; production value `act_1742876583597558`). Both are required in live mode. If either is unset, empty or malformed, no ads Graph call happens anywhere and every org reads `not_connected`.
   - `MetaAdAccount.adAccountId` is `@unique` on its own column, so one ad account can never be stored under two orgs.
   - `resolveAdsConfig(orgId)` returns `not_connected` for every org except the bound one. Env credentials are only ever used for the bound org. `syncAllOrgs()` syncs only the bound org. Every `read.ts` function returns the `not_connected` shape when `user.organizationId` isn't the bound org. `saveConnectorCredentials` refuses ads fields for any other org.
2. **The bound org must be the org that receives Meta leads.** That is whatever `resolveMetaOrg()` in `src/lib/meta/webhook-context.ts` returns (the owner of the oldest enabled META_LEAD_ADS source). The connect script prints both and refuses `--commit` when they differ. Nothing in `docs/WORKSPACE-CLEANUP.md` is taken as fact: that doc itself says the preview and live cutover aren't complete, so whether one org or several are live is whatever the script observes on the day. The runtime Connection view shows a red item if the two ever drift apart.
3. **Positive route table, fail-closed.** The new Graph client (`src/lib/meta/ads/graph-client.ts`) only sends requests that match an explicit allowed route (§2.3). Everything else is refused before `fetch`. Responses are checked too: any row whose `account_id` isn't allowed is dropped and audited before it's cached or stored. Refusals are audited with a hash-only reference (`acct#` plus 10 hex characters). No digits of a refused id are ever stored or shown, and there is no deny-list env var naming any other account.
4. **Separate ads credentials, from one source, on ProdigyFlo's own app, with the smallest scopes.**
   - Ads use their own credential set: vault fields `adsAppId`, `adsAppSecret`, `adsSystemUserToken` on the META_ADS connector, or env `META_ADS_APP_ID`, `META_ADS_APP_SECRET`, `META_ADS_SYSTEM_USER_TOKEN`. The lead-intake fields (`appId`, `appSecret`, `systemUserToken`, `pageAccessToken`) are never used for ads, and the ads fields are never used for intake.
   - `resolveAdsConfig` takes **one complete set from one source**: the vault when any ads field is present there, else env. It never mixes vault and env field by field. An incomplete vault set means `not_connected` with "Ads credentials are incomplete", with no fallback to env.
   - The system user is new, made for ProdigyFlo, and gets **ads_read** (plus read_insights) on SCS General 1 only. No `business_management`, no Page or leads permissions, no `ads_management` while writes are off.
   - The connect script verifies all of this with `debug_token` before it writes anything (§5.1).
5. **Pages read the database only.** A cron route syncs from Graph, and no page render calls Graph.
6. **Lead attribution comes from the JSON Dakota's code already stores. The ads token never reads leads.** `Client.leadAttribution` and `CallCenterLead.leadAttribution` (written by `storedAttribution()` in `src/lib/meta/attribution.ts` at intake) hold `leadgenId`, `adId`, `adsetId`, `campaignId`, `formId`, `platform`, `isOrganic` and `capturedAt`. The funnel joins on those ids. The ads token is used only to ask which account an unknown ad id belongs to (`GET /{ad_id}?fields=account_id`), cached in `MetaObjectAccount`. `attribution.ts` is reused, never forked.
7. **Graph-supplied ad, ad set and campaign NAMES are no longer stored at intake (P0-A).** Names come at read time from the synced, allowlisted Campaign, AdSet and MetaAd rows. This changes Dakota's merged feature, so P0-A is built on this branch but merges only after Dakota reviews it and the owner signs off (§3.9).
8. **The live lead path stays byte-identical.** `graph()` and `fetchLead` in `src/lib/meta/graph.ts` are not edited, except that the `GRAPH` constant comes from `graphBase()`. All new ads code goes through `graph-client.ts` only. `GRAPH_LEAD_FIELDS` is not edited in P0, so the webhook's outbound lead read keeps the same path and fields.
9. **Mock never runs in production.** `adsMockAllowed()` follows `metaFixtureModeEnabled()`: never when `VERCEL_ENV=production` or on the prodigyflo.ai hosts, only in development, test and preview. In production, missing ads credentials means `not_connected` and nothing is written. Mock rows always carry `adAccountId` `act_mock_<orgId prefix>` and are hidden from every consumer outside mock mode.
10. **Ads health lives on `MetaAdAccount`, never on `Connector.status`.** That connector drives lead intake, so the ads sync never changes it.
11. **Graph v25.0 by default** (`META_GRAPH_VERSION`). v24 was sunset on 2026-10-06. In the new client the token always travels in `Authorization: Bearer` and never in a URL, log, error or client payload. `appsecret_proof` is sent on every call whenever the ads app secret is set (apps with "Require App Secret" refuse calls without it), except when `debug_token` already said the token belongs to a different app; an "Invalid appsecret_proof" answer is retried once without it (§2.3).
12. **Stay out of telephony, and keep merges mechanical.** Never edit `src/app/api/jobs/run/route.ts` or `src/lib/telephony/**`. Organization back-relations go in one block at the end of the model, and the cron is one new array element in `vercel.json`.

## 1. Gap table

| # | Capability | Today (0b03c61) | P0 / Later |
|---|---|---|---|
| A0 | Account bound to one org; other orgs see nothing | **missing**: env creds apply to every org | **P0** |
| A1 | Token only in Authorization header | **partial**: `graph.ts`, `instagram.ts`, `tools/meta-lib.mjs` put it in the query | P0 for the new client; legacy paths Later |
| A2 | Configurable Graph version, default v25+ | **missing**: v21.0 hard-coded in `graph.ts`, `instagram.ts`, `tools/meta-lib.mjs` | P0: `graph.ts` and `instagram.ts` constant swap; tools Later |
| A3 | Positive route table plus response-side account check | **missing** | P0 |
| A4 | Account id validation, refusal plus hash-only audit | **missing**: any id accepted | P0 |
| A5 | Writes verify the object's ad account | **missing** | P0 (writes off by default, checked when on) |
| A6 | Ads health separate from intake connector | **missing** | P0 |
| A7 | Separate ads credentials, one source, verified app and scopes | **missing**: vault/env merged field by field | P0 |
| A8 | Mock never in production | **missing**: `getMetaProviderFor` falls back to mock silently | P0 |
| B1 | Snapshot: account plus ads edge plus insights per window | **partial** | P0 |
| B2 | Windows today / 7d / 30d / this month / max | **missing** | P0 |
| B3 | Spend, impressions, reach, link clicks, leads, LPV; CPL/CTR/CPC/CPM/frequency (null on 0) | **partial**; live leads = 0 | P0 |
| B4 | Leads from `actions` (fixed order) | **missing** | P0 |
| B5 | Tree from the ads edge incl. archived, ratio of sums, tree total = account total | **missing** | P0 |
| B6 | Creative summary | **missing** | P0 summary; preview iframe and video Later |
| B7 | Counts | partial | P0 |
| B8 | Daily trend incl. today | partial | P0 |
| C | Multi-account compare | n/a | Later |
| D | Spend cycle with restatement window | **missing** | P0 |
| E1 | Card on file, unpaid balance, spent, cap, status, 90-day spend, billing link | **partial** | P0 |
| E2–E3 | Inferred payment ledger, idempotent, replica-safe | **missing** | P0 |
| E4 | Status words plus owner alert | partial | P0 (in-app; email Later) |
| F2 | Attribution from each lead's own ad_id | **have** (stored JSON, 0b03c61) | P0: reuse it for the funnel |
| F2b | Attribution names from foreign accounts stored and shown | **leaks** (names stored and shown for any account) | **P0-A, owner sign-off** |
| F4 | Funnel by ad | **missing** | P0 |
| F5 | Attribution-doubt flag and "broken" fingerprint | missing | P0 |
| F6 | Funnel by form answer | missing | Later |
| G | Scores, analyst, speed alerts | missing | Later |
| H | On/off and budget writes | **have**, unchecked | P0: guarded, default off |
| K | Webhook handshake, HMAC, dedupe | **have** | keep untouched |
| L1 | DB-backed read model | **missing** | P0 |
| L2–L3 | Rate back-off, full error kinds, honest 190 | **missing** | P0 |
| L4 | Paging outside batch, limit 500, truncation surfaced | **missing** | P0 |
| L5 | Usage headers checked after every response | missing | P0 |
| L6 | Per-account sync lease, idempotent billing events | **missing** | P0 |
| N | Role gates, audit, actions gated individually | partial | P0 (§2.6) |
| O | Legacy and foreign rows hidden in every consumer | **missing**: marketing-metrics, analytics, revops, index.ts, ops.ts read unfiltered | **P0** |
| — | `createAdAccount` | have | **P0: disable** |
| — | Catalog placeholders show real third-party app and business ids | have | **P0: replace with neutral text** |
| — | /marketing/meta reachable under `PRODIGYFLO_FINAL_DESK` | **missing** | P0 |

## 2. Shared contract (BACKEND and UI both build to this)

### 2.1 Environment variables

| Name | Required | Default | Meaning |
|---|---|---|---|
| `META_ADS_ORG_ID` | **yes for live** | — | The one `Organization.id` the account is bound to. |
| `META_ALLOWED_AD_ACCOUNTS` | **yes for live** | — | Comma list, `act_` prefix optional. Production: `act_1742876583597558`. Empty or malformed means fail closed. All listed accounts bind to `META_ADS_ORG_ID`. |
| `META_ADS_APP_ID` | live, unless in the vault | — | ProdigyFlo's own Meta app. The connect script and `appsecret_proof` compare against the app id of the set in use (vault `adsAppId` or this). |
| `META_ADS_APP_SECRET` | live, unless in the vault | — | That app's secret (for `appsecret_proof`). |
| `META_ADS_SYSTEM_USER_TOKEN` | live, unless in the vault | — | The ads-only system user token. The vault set wins as a whole set, never per field. |
| `META_GRAPH_VERSION` | no | `v25.0` | Must match `/^v\d+\.\d+$/`, else the default. |
| `META_ADS_WRITES_ENABLED` | no | unset (off) | `true` re-enables pause/resume, budget and cap writes, still guarded by A5. |
| `META_SYNC_FULL_MINUTES` | no | `30` | Minimum minutes between full syncs. |
| `META_ADS_CYCLE_DAYS` | no | `15` | Default length of a new cycle. |
| `CRON_SECRET` / `JOBS_TOKEN` | live | — | Existing, checked by `cronAuthorized`. |

The lead-intake variables (`META_APP_ID`, `META_APP_SECRET`, `META_SYSTEM_USER_TOKEN`, `META_PAGE_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_BUSINESS_ID`) are unchanged and never read by ads code. `META_AD_ACCOUNT_ID` stays only for the legacy provider and is dropped (and audited) unless it is allowlisted **and** the org is the bound org.

Add all new ones to `.env.example` with comments. The only real ad account id allowed anywhere in the repo is `act_1742876583597558`.

### 2.2 Binding and allowlist (`src/lib/meta/ads/allowlist.ts`)

```ts
export function normalizeAdAccountId(raw: string): string | null   // decodeURIComponent until stable; 'act_123'|'123' -> 'act_123'; 5..20 digits; else null
export type AdsBinding = { orgId: string; accounts: ReadonlySet<string> } | null
export function adsBinding(env = process.env): AdsBinding          // null unless BOTH vars are set and every account parses
export function isAllowedAdAccount(id: string | null | undefined, env?): boolean
export function isBoundOrg(orgId: string | null | undefined, env?): boolean
export function allowedAccountsForOrg(orgId: string, env?): string[]  // [] unless orgId is bound; mock id appended only when adsMockAllowed()
export function adsMockAllowed(env = process.env): boolean          // same rules as metaFixtureModeEnabled(), without the opt-in var
export class AdAccountNotAllowedError extends Error { readonly ref: string; readonly reason: 'not_allowlisted'|'malformed'|'not_bound'|'unbound_org'|'route' }
export function assertAllowedAdAccount(id: string | null | undefined, orgId: string, env?): string
export function refFor(id: string): string                          // 'acct#' + hashValue(id).slice(0, 10); no digits of the id
export async function auditRefusal(orgId: string | null, ref: string, reason: string, where: string, actor?: SessionUser): Promise<void>
```

- `auditRefusal` writes `AuditEvent{action:'meta.ad_account.refused', entityType:'MetaAdAccount', entityId: ref, summary: where}` into the **bound** org (or the actor's org) with `recordAudit` when there's an actor, otherwise a direct insert with `actorLabel:'system:meta-sync'`. At most one row per (org, ref, where) per hour.
- **Where it is enforced** (all required):
  1. The Graph client: the positive route table plus the response check (§2.3).
  2. `resolveAdsConfig`: unbound org → `not_connected`. Env and vault ads credentials are only read for the bound org.
  3. `syncAllOrgs`: only the bound org; no candidate-org scan.
  4. `read.ts`: every function checks `isBoundOrg(user.organizationId)` first and filters `adAccountId IN allowedAccountsForOrg(...)`.
  5. `saveConnectorCredentials` (`src/lib/connectors/provision.ts`), kind META_ADS: for an org that isn't bound, refuse `adAccountId`, `adsAppId`, `adsAppSecret`, `adsSystemUserToken` with "Ads reporting is connected to a different ProdigyFlo workspace." For the bound org, refuse a non-allowed `adAccountId` with "This ad account isn't approved for ProdigyFlo."
  6. `metaCredentialsFor` wrapper: drops `adAccountId` (vault or env) unless allowed **and** the org is bound, and audits the drop. Done as a wrapper, not by rewriting the function body.
  7. Every sync write: rows carry `adAccountId`, asserted before write.
  8. Every existing consumer of Campaign/AdSet/CampaignDailyStat uses `allowedMetaCampaignWhere()` / `allowedMetaAdSetWhere()` (§3.7).
  9. `MetaLeadTouch` rows for ads outside the allowlist store no ad, ad set, campaign or account ids; `outside=true`, counted only (§3.6).
  10. `GraphMetaAdsProvider.createAdAccount` always throws "Creating ad accounts is turned off in ProdigyFlo."

### 2.3 Graph client (`src/lib/meta/ads/graph-client.ts`)

```ts
export function graphBase(env = process.env): string                // 'https://graph.facebook.com/' + version
export type GraphErrorKind = 'rate' | 'permission' | 'token' | 'not_found' | 'config' | 'transient' | 'blocked' | 'other'
export class MetaGraphError extends Error { kind: GraphErrorKind; code?: number; subcode?: number; status: number; plain: string }
export type UsageSnapshot = { maxPct: number; regainSeconds: number; resetSeconds: number }
export type Route =
  | { r: 'account'; account: string; fields: AccountFields }
  | { r: 'edge'; account: string; edge: 'campaigns'|'adsets'|'ads'|'insights'; params: EdgeParams }
  | { r: 'object'; objectId: string; fields: ObjectFields }           // objectId must resolve to a local allowed row in the bound org
  | { r: 'objectInsights'; objectId: string; params: InsightParams }  // same rule
  | { r: 'ownership'; objectId: string }                              // GET /{id}?fields=account_id only
  | { r: 'debugToken' }                                               // input_token = access_token = the client's own token
  | { r: 'myAccounts' }                                               // me/adaccounts, fields forced to id,account_id, limit 100
  | { r: 'write'; objectId: string; form: Record<string,string> }     // writes enabled + local allowed row
export function createGraphClient(opts: { orgId: string; token: string; appId: string; appSecret?: string; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; onUsage?: (u: UsageSnapshot) => void }): {
  get<T>(route: Route): Promise<{ body: T; usage: UsageSnapshot | null }>
  getAllPages<T>(route: Route, maxPages?: number /* default 20 */): Promise<{ data: T[]; truncated: boolean }>
  batch<T>(routes: Route[] /* ≤50, single-object reads only, never paged edges */): Promise<Array<{ ok: true; body: T } | { ok: false; error: MetaGraphError }>>
  post<T>(route: Extract<Route, { r: 'write' }>): Promise<T>
}
export function classifyGraphError(status: number, err: { code?: number; error_subcode?: number; message?: string }): { kind: GraphErrorKind; plain: string }
export function parseUsageHeaders(h: Headers): UsageSnapshot | null
```

**The route table is the only way in.** Callers pass a `Route`, never a path string. The client builds the URL itself from the route, so a caller can't hand it a raw path:

- `account` and `edge` require `account` in the allowlist **and** the client's `orgId` to be bound.
- `fields` and params come from fixed constants per route (`ACCOUNT_FIELDS`, `CAMPAIGN_FIELDS`, `ADSET_FIELDS`, `AD_FIELDS` with the `creative{...}` expansion, `INSIGHT_FIELDS`). A caller can't supply a field string, so `{...}` expansions on `me`, business or any other node can't happen. `account_id` is always part of the campaign, ad set, ad and insight fields.
- `object` and `objectInsights` need a local `Campaign`, `AdSet` or `MetaAd` row with that `externalId`, in the bound org, whose `adAccountId` is allowed. Without one the request is refused before `fetch`.
- `ownership` sends only `fields=account_id`, whatever the id is. The client returns `{ allowed: boolean }`, never the account id.
- `debugToken` sends the client's own token as both `input_token` and the bearer.
- `myAccounts` forces `fields=id,account_id`. The client returns `{ allowedVisible: string[]; othersVisible: boolean }` and never any other id.
- No route can carry `ids=`, a `business` node, `owned_ad_accounts`, `client_ad_accounts`, a version prefix or an encoded path. Ids are digits only (`/^\d{5,20}$/`, or `act_` plus digits), checked after `decodeURIComponent` runs until stable.
- `batch` builds each `relative_url` from a route through the same builder (no version prefix) and is used only for single-object reads. Paged edges are never batched.

**Response check.** Before anything is returned, cached or stored, every row from `edge`, `objectInsights` and `object` must carry an allowed `account_id`. Any other row is dropped, counted and audited once per run with `refFor(id)`.

**Paging.** `limit=500` on edges and insights, `paging.next` followed outside any batch up to `maxPages`, and `truncated:true` surfaced to the sync (shown as "Some rows weren't loaded" on the Connection view).

**Token and proof.**

- The token travels in `Authorization: Bearer` only.
- `appsecret_proof = HMAC_SHA256(appSecret, token)` is added to every call (URL, batch body, `debug_token` batch body) whenever `appSecret` is set, unless the cached `tokenAppId` is known and differs from `appId`. On code 100 "Invalid appsecret_proof" the call is retried once without it and the client stops sending it. `meta-ads-connect --commit` stores `tokenAppId` from its check.
- Error text never includes the token, the URL, the proof or Meta's raw message.

**Usage.** `parseUsageHeaders` reads `x-business-use-case-usage`, `x-ad-account-usage` and `x-app-usage` after **every** response and calls `onUsage`. `maxPct` is the highest percentage seen, `regainSeconds` comes from `estimated_time_to_regain_access` (minutes × 60) only, and `resetSeconds` from `reset_time_duration`. `reset_time_duration` is the decay time of the current score and is above 0 after almost any call, so it never causes a stop; it only lengthens a back-off once a stop is decided.

**Error kinds** (`classifyGraphError`, with a test table covering every row):

| Kind | Codes | Plain copy |
|---|---|---|
| token | 190 (subcode 463 expired, 460 password changed, 458 app removed, 467 invalid, other), 102 | 463: "The Meta ads token expired. Generate a new System User token and save it in Connectors → Meta Ads." 460/467: "The Meta ads token was signed out or revoked. Generate a new System User token." 458: "The ProdigyFlo app was removed from the system user. Re-add it in Meta Business Settings, then generate a new token." Other: "Meta says the ads token is no longer valid. Generate a new System User token." |
| config | 100 with a message mentioning `appsecret_proof` | "The ads token and the app secret don't belong to the same Meta app. Check Connectors → Meta Ads." |
| permission | 10, 200, 294, 272, HTTP 403, message `/permission\|not authorized/i` | "Meta refused access. The ProdigyFlo system user needs View performance on SCS General 1." |
| rate | 4, 17, 32, 613, 80000, 80001, 80004, 80014, HTTP 429 | "Meta asked us to slow down. Numbers will refresh after {time}." |
| blocked | 368 | "Meta has temporarily blocked these requests. We'll try again later." |
| not_found | 100 with subcode 33 | (internal; for ownership it means outside) |
| transient | 1, 2, HTTP 5xx | "Meta had a temporary problem. We'll retry on the next sync." |
| other | anything else | "Meta didn't answer as expected. We'll retry on the next sync." |

### 2.4 Prisma (one additive migration `prisma/migrations/20261008120000_meta_ads_scs/`)

Additive columns:

- `Campaign`: `adAccountId String?`, `effectiveStatus String?`, `lifetimeBudget Decimal? @db.Decimal(12,2)`, `objective String?`, `metaCreatedAt DateTime?`, `@@index([organizationId, adAccountId])`.
- `AdSet`: `adAccountId String?`, `effectiveStatus String?`, `lifetimeBudget Decimal? @db.Decimal(12,2)`, `optimizationGoal String?`, `@@index([organizationId, adAccountId])`.

No unique index on `Campaign(organizationId, externalId)` in P0. Campaign mirroring runs only while holding the sync lease (§3.3), and it repairs pre-existing duplicates by always updating the oldest row.

New models (each with `organizationId` and a cascade relation to Organization; **all** back-relations added in one block at the end of `model Organization`):

```prisma
model MetaAdAccount {
  id String @id @default(cuid())
  organizationId String
  adAccountId    String   @unique          // normalized, allowlisted, one org only
  name String?  currency String @default("USD")  timezoneName String?
  accountStatus Int?  disableReason Int?
  balanceCents BigInt?  amountSpentCents BigInt?  spendCapCents BigInt?
  fundingDisplay String?  fundingType Int?
  pendingCharge Json?                       // detector state (§3.4)
  billingVersion Int @default(0)            // optimistic lock for pendingCharge
  lastReadingAt DateTime?                   // last accepted snapshot
  cycleDays Int @default(15)
  syncLeaseUntil DateTime?  syncLeaseOwner String?
  lastManualRefreshAt DateTime?
  lastSnapshotAt DateTime?  lastFullSyncAt DateTime?  lastConnectionCheckAt DateTime?
  backoffUntil DateTime?  lastUsagePct Int?  lastTruncated Boolean @default(false)
  lastErrorKind String?  lastError String?  lastErrorAt DateTime?
  tokenValid Boolean?  tokenExpiresAt DateTime?  tokenAppId String?  tokenType String?
  tokenScopes String[] @default([])
  tokenSeesOthers Boolean @default(false)    // never which ones
  leadOrgMatches Boolean?                    // bound org == resolveMetaOrg()
  outsideLeadCount Int @default(0)
  createdAt DateTime @default(now())  updatedAt DateTime @updatedAt
  @@index([organizationId])
}

model MetaAd {
  id String @id @default(cuid())
  organizationId String  adAccountId String
  campaignId String  adSetId String?
  externalId String  name String  status String  effectiveStatus String?
  removed Boolean @default(false)           // not seen in the last full sync; never hard-deleted
  formId String?  thumbnailUrl String?  headline String?  body String?  cta String?  linkUrl String?
  metaCreatedAt DateTime?  syncedAt DateTime @default(now())
  createdAt DateTime @default(now())  updatedAt DateTime @updatedAt
  @@unique([organizationId, externalId])
  @@index([organizationId, adAccountId])  @@index([campaignId])  @@index([adSetId])
}

/// Which account an object id belongs to, from GET /{id}?fields=account_id.
/// Never stores a foreign account id: allowed → that id; anything else → null + outside.
model MetaObjectAccount {
  objectId String @id
  adAccountId String?
  outside Boolean
  reason String          // 'allowed' | 'other_account' | 'no_access' | 'not_found'
  checkedAt DateTime @default(now())
}

enum MetaInsightLevel { ACCOUNT CAMPAIGN ADSET AD }
enum MetaInsightWindow { TODAY LAST_7D LAST_30D THIS_MONTH MAXIMUM }

model MetaInsightDaily {                     // account timezone dates; leads by conversion time
  id String @id @default(cuid())
  organizationId String  adAccountId String
  level MetaInsightLevel  objectId String  date DateTime @db.Date
  spend Decimal @default(0) @db.Decimal(12,2)
  impressions Int @default(0)  reach Int @default(0)  clicks Int @default(0)
  linkClicks Int @default(0)  leads Int @default(0)  landingPageViews Int @default(0)
  updatedAt DateTime @updatedAt
  @@unique([organizationId, level, objectId, date])
  @@index([organizationId, adAccountId, level, date])
}

model MetaInsightSummary {                   // window totals straight from Meta
  id String @id @default(cuid())
  organizationId String  adAccountId String
  level MetaInsightLevel  objectId String  window MetaInsightWindow
  spend Decimal @default(0) @db.Decimal(12,2)
  impressions Int @default(0)  reach Int @default(0)  clicks Int @default(0)
  linkClicks Int @default(0)  leads Int @default(0)  landingPageViews Int @default(0)
  frequency Decimal? @db.Decimal(8,3)
  dateStart DateTime? @db.Date  dateStop DateTime? @db.Date
  partial Boolean @default(false)            // MAXIMUM fell back (§3.3)
  updatedAt DateTime @updatedAt
  @@unique([organizationId, level, objectId, window])
  @@index([organizationId, adAccountId, window])
}

model MetaAccountSnapshot {
  id String @id @default(cuid())
  organizationId String  adAccountId String  takenAt DateTime @default(now())
  balanceCents BigInt?  amountSpentCents BigInt?  spendCapCents BigInt?
  accountStatus Int?  fundingDisplay String?  fundingType Int?
  stale Boolean @default(false)             // amount_spent went backwards: ignored by the detector
  @@index([organizationId, adAccountId, takenAt])
}

enum MetaBillingKind { PAYMENT STATUS_CHANGE CARD_CHANGE }
model MetaBillingEvent {
  id String @id @default(cuid())
  organizationId String  adAccountId String
  kind MetaBillingKind  occurredAt DateTime
  fromSnapshotId String                     // the snapshot that started it; idempotency key
  amountCents BigInt?  approximate Boolean @default(true)
  before String?  after String?
  createdAt DateTime @default(now())
  @@unique([adAccountId, kind, fromSnapshotId])
  @@index([organizationId, adAccountId, occurredAt])
}

model MetaSpendCycle {
  id String @id @default(cuid())
  organizationId String  adAccountId String
  number Int  lengthDays Int  startedAt DateTime  endedAt DateTime?
  startedById String?
  startDayExcludedSpend Decimal @default(0) @db.Decimal(12,2)
  startDayExcludedAt DateTime?   // when the hourly split last succeeded; null past 48 h => approximate
  spendApproximate Boolean @default(false)
  closedSpend Decimal? @db.Decimal(12,2)  closedLeads Int?
  finalAfter DateTime?                      // endedAt + 3 days; recomputed until then
  createdAt DateTime @default(now())
  @@unique([adAccountId, number])
  @@index([organizationId, adAccountId, endedAt])
}

/// Derived index over stored leadAttribution JSON. Rebuildable; never read from Graph.
model MetaLeadTouch {
  id String @id @default(cuid())
  organizationId String  leadgenId String
  adAccountId String?  adId String?  adSetId String?  campaignId String?  formId String?   // null when outside
  platform String?  isOrganic Boolean?
  status String        // 'matched' | 'outside' | 'unmatched' | 'pending'
  clientId String?  callCenterLeadId String?
  leadCreatedAt DateTime?
  checkedAt DateTime?
  createdAt DateTime @default(now())  updatedAt DateTime @updatedAt
  @@unique([organizationId, leadgenId])
  @@index([organizationId, adId])  @@index([organizationId, status])
}
```

The migration is hand-checked to contain only `CREATE TABLE`, `CREATE TYPE`, `ALTER TABLE ... ADD COLUMN` and `CREATE INDEX`/`CREATE UNIQUE INDEX` on new tables. No drops, no renames, no NOT NULL without a default.

### 2.5 Read model (`src/lib/meta/ads/read.ts`)

```ts
export type AdsWindow = 'today' | '7d' | '30d' | 'month' | 'max'
export function parseAdsWindow(v: string | undefined): AdsWindow           // default '30d'
export type Metrics = { spend: number; impressions: number; reach: number | null; clicks: number; linkClicks: number; leads: number; landingPageViews: number;
  cpl: number | null; ctr: number | null; cpc: number | null; cpm: number | null; frequency: number | null }
export type AdNode = { id: string; externalId: string; name: string; status: string; effectiveStatus: string | null; removed: boolean; metrics: Metrics;
  creative: { thumbnailUrl: string | null; headline: string | null; body: string | null; cta: string | null; linkHost: string | null };
  flags: { zeroLeadStreakDays: number; highFrequency: boolean; lowCtr: boolean } }
export type AdSetNode = { id: string; externalId: string; name: string; status: string; dailyBudget: number | null; lifetimeBudget: number | null; metrics: Metrics; ads: AdNode[] }
export type CampaignNode = { kind: 'campaign'; id: string; externalId: string; name: string; status: string; objective: string | null; dailyBudget: number | null; lifetimeBudget: number | null; metrics: Metrics; adSets: AdSetNode[] }
export type RemainderNode = { kind: 'remainder'; name: 'Removed or archived ads'; metrics: Metrics }
export type AccountCard = { adAccountId: string; name: string; currency: string; timezoneName: string | null; statusCode: number | null; statusWords: string; statusTone: 'ok'|'warn'|'bad';
  balance: number | null; amountSpent: number | null; spendCap: number | null; card: string | null; cardType: string | null; billingUrl: string }
export type SyncState = { mode: 'mock' | 'live' | 'not_connected'; lastFullSyncAt: Date | null; lastSnapshotAt: Date | null; stale: boolean;
  error: { kind: GraphErrorKind; plain: string; at: Date } | null; backoffUntil: Date | null; partialMax: boolean }
export type AdsDashboard = { account: AccountCard | null; window: AdsWindow; totals: Metrics; counts: { campaigns: number; adSets: number; ads: number; activeAds: number };
  tree: (CampaignNode | RemainderNode)[]; daily: { date: string; spend: number; leads: number }[]; sync: SyncState; writesEnabled: boolean; canManage: boolean }
export async function getAdsDashboard(user: SessionUser, window: AdsWindow): Promise<AdsDashboard>

export type BillingView = { account: AccountCard; spend90: { date: string; spend: number }[]; detector: 'on' | 'off_funding';
  ledger: { id: string; kind: 'PAYMENT'|'STATUS_CHANGE'|'CARD_CHANGE'; at: Date; amount: number | null; approximate: boolean; before: string | null; after: string | null }[];
  pending: { amount: number; since: Date } | null }
export async function getBillingView(user: SessionUser): Promise<BillingView | null>     // connectors:manage

export type CycleView = { current: { number: number; startedAt: Date; endsAt: Date; day: number; lengthDays: number; overdue: boolean; spend: number; leads: number; cpl: number | null; approximate: boolean } | null;
  history: { number: number; startedAt: Date; endedAt: Date; spend: number | null; leads: number | null; final: boolean; finalAfter: Date | null }[]; lengthDays: number }   // last 6
export async function getCycleView(user: SessionUser): Promise<CycleView>

export type FunnelRange = '7d' | '30d' | 'all'
export type FunnelRow = { adExternalId: string; adName: string; campaignName: string; spend: number; metaLeads: number;
  leads: number; contacted: number; booked: number; sat: number; sold: number; revenue: number;
  costPerLead: number | null; costPerBooked: number | null; costPerSat: number | null; costPerSale: number | null; roas: number | null; attributionDoubt: boolean }
export type FunnelView = { range: FunnelRange; rows: FunnelRow[]; unmatched: number; outside: number; pending: number; attributionBroken: boolean; leadOrgMatches: boolean | null }
export async function getFunnelView(user: SessionUser, range: FunnelRange): Promise<FunnelView>

export type ConnectionView = { mode: SyncState['mode']; boundHere: boolean; allowlist: { configured: boolean; accounts: { id: string; reachable: boolean | null; name: string | null }[] };
  token: { valid: boolean | null; expiresAt: Date | null; scopes: string[]; type: string | null; appMatches: boolean | null; targetsOk: boolean | null; seesOthers: boolean };
  leadOrgMatches: boolean | null; lastFullSyncAt: Date | null; lastSnapshotAt: Date | null; usagePct: number | null; backoffUntil: Date | null; truncated: boolean;
  errors: { kind: GraphErrorKind; plain: string; at: Date }[]; writesEnabled: boolean }
export async function getConnectionView(user: SessionUser): Promise<ConnectionView>      // connectors:manage
```

Notes on the types:

- `SyncState.mode` comes from `resolveAdsConfig` plus `adsMockAllowed()`, never from whether credentials happen to be present.
- `tree` ends with a `RemainderNode` whenever account spend minus tree spend is at least $0.01, so the tree always sums to the account total.
- `BillingView.detector` is off for any funding other than card (1) or direct debit (17).
- `ConnectionView` has no webhook URL or verify token; those stay on the existing intake surface.
- Mock mode returns the same shapes from rows written by `MockAdsSource`, so the UI branches on mode only for the badge.

**Rules:**

- Every function first checks `isBoundOrg(user.organizationId)`. When it isn't bound, it returns the `not_connected` shape with empty data and makes **no** DB query for ads tables.
- Every query filters `organizationId = bound` and `adAccountId IN allowedAccountsForOrg(...)`.
- **Serialization boundary:** every BigInt and Decimal becomes a `number`, every Date stays a Date (RSC-safe). A test runs `JSON.stringify` over each view against seeded rows.
- `stale` means `lastFullSyncAt` is older than 2 × `META_SYNC_FULL_MINUTES`, or `lastSnapshotAt` is older than 30 minutes.

### 2.6 Permissions and routes

| Surface | Gate |
|---|---|
| `/marketing/meta` (Overview, Ads, Funnel, Cycle) | `connectors:read` + bound org |
| Billing, Connection, Refresh now, Start cycle, Cycle length, Re-check, Re-match | `connectors:manage` + bound org |
| Writes | `connectors:manage` + `META_ADS_WRITES_ENABLED=true` + A5 |
| `GET /api/jobs/meta-sync` | `cronAuthorized(req, [process.env.JOBS_TOKEN])`, checked first |

- **Server actions** (`src/app/(app)/marketing/meta/ads-actions.ts`): each export calls `requirePermission(...)` itself, resolves the org from the session, and accepts **no** org id or ad account id argument. A Next 16 action can be POSTed directly by its id, whatever page renders it.
  - `refreshAdsNow()`: the 2-minute limit lives in the DB, as a conditional `updateMany` on `lastManualRefreshAt < now − 2 min`. If the sync lease is held, it answers "Already refreshing".
  - `startSpendCycle()`, `setCycleLength(days 1..90)`, `recheckConnection()`, `rematchLeads()`.
  - Each one calls `recordAudit` and `revalidatePath('/marketing/meta')`.
- **No new data routes** under `/api/meta/**` or `/api/jobs/**` apart from `/api/jobs/meta-sync`. `proxy.ts` treats both prefixes as public. A repo test pins the route list (§3.10).
- `src/lib/staff-routes.ts`: under `PRODIGYFLO_FINAL_DESK=true`, allow `SUPER_ADMIN` on `/marketing/meta` and `/marketing/meta/*`; CLOSER stays denied.
- No account id is read from any search param.

### 2.7 Units and words

- Graph money strings (`balance`, `amount_spent`, `spend_cap`, `daily_budget`, `lifetime_budget`) are minor units. `minorToMajor(value, currency)` divides by 100, or by 1 for zero-decimal currencies (JPY, KRW, CLP, VND, ISK, TWD, HUF). Insights `spend` is already in major units.
- **Status words:** 1 Active (ok), 2 Disabled (bad), 3 Unpaid (bad), 7 In review (warn), 8 Pending settlement (warn), 9 Grace period (bad), 100 Pending closure (bad), 101 Closed (bad), 201 Active (ok), 202 Closed (bad); anything else "Unknown (code N)" (warn).
- **Funding types:** 1 Card, 2 Meta balance, 3 Paid credit, 4 Credit line, 5 Order, 6 Invoice, 7 Token, 8 External funding, 12 or 13 PayPal, 17 Direct debit, 20 Stored balance; anything else "Other".
- The card display is shown exactly as Meta's `funding_source_details.display_string`, which Meta already masks (e.g. "Visa *1234").
- Billing deep link: `https://business.facebook.com/billing_hub/accounts/details?asset_id=<digits>`, built only from the allowed id.
- Ledger rows read "Payment or charge, about $X", "Status changed: A → B" or "Card changed".

## 3. BACKEND scope

Read `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` and `.../02-guides/caching-without-cache-components.md` first. `cacheComponents` is off.

### 3.1 Files

New, under `src/lib/meta/ads/`, each with a sibling `*.test.ts`:

- `allowlist.ts` (§2.2)
- `graph-client.ts` (§2.3)
- `metrics.ts`, `creative.ts`, `tree.ts` (adds the remainder row), `billing.ts` (§3.4), `cycle.ts`, `funnel.ts`
- `config.ts`: `resolveAdsConfig(orgId)` → `{ mode, creds?: { token, appId, appSecret? }, adAccountId?, reason? }`, applying decisions 1, 4 and 9
- `source.ts`: `AdsSource` with `GraphAdsSource` and `MockAdsSource`. There is no `leads()` method.
- `sync.ts`, `read.ts`
- `where.ts`: `allowedMetaCampaignWhere(orgId)`, `allowedMetaAdSetWhere(orgId)`, `allowedCampaignDailyStatWhere(orgId)` (§3.7)
- `attribution-names.ts`: `attributionRowsFor(orgId, raw)`, server-only (§3.9)
- `touches.ts`: `rebuildLeadTouches(orgId, { limit })` (§3.6)

New route and scripts:

- `src/app/api/jobs/meta-sync/route.ts`: `GET`, `maxDuration = 300`, `dynamic = 'force-dynamic'`. `cronAuthorized` comes first, then `syncAllOrgs({ budgetMs: 240_000 })`. The JSON response holds counts only.
- `scripts/meta-ads-connect.ts` (§5.1)
- `scripts/meta-ads-classify-legacy.ts` (§3.7), dry-run by default
- `scripts/meta-attribution-scrub.ts` (§3.9), dry-run by default

Fixtures go in `tests/fixtures/meta-graph/`. Every id is synthetic except `1742876583597558`. The fake foreign account is `act_999000111222333` and lives as a constant in `tests/fixtures/meta-graph/ids.ts`. The repo canary (§3.10) allows exactly these two.

**Minimal edits to existing files** (small hunks; P0-A edits are listed separately in §3.9):

- `src/lib/meta/graph.ts`: replace the `GRAPH` constant with `graphBase()`. `act()` calls `assertAllowedAdAccount`. Write methods call `assertWritableObject(orgId, externalId)` first. `createAdAccount` throws. **`graph()` and `fetchLead` are not touched.** In P0 the legacy ads read methods (`listCampaigns`, `listAdSets`, `accountInfo`, `dailyStats`) are no longer called by any page, route or console command.
- `src/lib/meta/instagram.ts`: the version constant only, swapped to `graphBase()`.
- `src/lib/meta/index.ts`: `getMetaProviderFor` and `getMetaProvider` return the mock only when `adsMockAllowed()`. Otherwise they return a `DisconnectedMetaAdsProvider`: reads return empty, writes and `fetchLead` throw "Meta Ads isn't connected", and nothing is written. `monthSpend` and `campaignTrends` use the §3.7 fragment.
- `src/lib/meta/ops.ts`: `resolveTarget` and the console `list` use the §3.7 fragments. Writes go through `assertWritableObject`.
- `src/lib/meta/provider.ts`: the `metaCredentialsFor` wrapper (§2.2 rule 6).
- `src/lib/meta/webhook-context.ts`: export `resolveMetaOrg` (a one-word hunk).
- `src/lib/marketing-metrics.ts` (`getMarketingOverview`), `src/lib/analytics.ts` (`getCampaignPerformance`), `src/lib/revops.ts` (`getAttributionReport`): the §3.7 fragment.
- `src/lib/connectors/provision.ts`: the §2.2 rule 5 guard.
- `src/lib/connectors/catalog.ts` META_ADS:
  - replace the real app-id and business-id placeholders with "App ID from your Meta app" and "Business Manager ID", and the adAccountId placeholder with "act_ followed by digits";
  - add the three ads fields;
  - rewrite the setup copy: the ads system user gets ads_read on the approved ad account only, and lead intake keeps its own fields.
- `src/lib/staff-routes.ts` and `src/lib/final-desk/routes.test.ts` (§2.6).
- `prisma/schema.prisma` and the migration (§2.4).
- `vercel.json`: one new array element `{ "path": "/api/jobs/meta-sync", "schedule": "*/10 * * * *" }`. The existing element stays byte-identical.
- `.env.example` (§2.1).

### 3.2 Sources

```ts
export interface AdsSource {
  readonly kind: 'mock' | 'graph'
  account(): Promise<RawAccount>                       // 1 call; also returns usage
  campaigns(): Promise<{ rows: RawCampaign[]; truncated: boolean }>
  adSets(): Promise<{ rows: RawAdSet[]; truncated: boolean }>
  ads(): Promise<{ rows: RawAd[]; truncated: boolean }>   // effective_status incl. ARCHIVED, PAUSED, CAMPAIGN_PAUSED, ADSET_PAUSED, WITH_ISSUES, DISAPPROVED, PENDING_REVIEW, ACTIVE
  windowInsights(level: 'account'|'ad', w: AdsWindow): Promise<{ rows: RawInsight[]; truncated: boolean; partial: boolean }>
  daily(level: 'account'|'campaign', since: string, until: string): Promise<{ rows: RawInsight[]; truncated: boolean }>
  hourly(day: string): Promise<{ hour: number; spend: number }[] | null>
  ownership(objectId: string): Promise<'allowed' | 'other_account' | 'no_access' | 'not_found'>
  tokenInfo(): Promise<{ valid: boolean; appId: string | null; type: string | null; expiresAt: Date | null; scopes: string[]; adsTargets: string[] | 'all' }>
  visibleAccounts(): Promise<{ allowedVisible: string[]; othersVisible: boolean }>
}
```

- The account is fixed when the source is built. There is no account-id parameter.
- Every insight call passes `action_report_time=conversion` and `use_unified_attribution_setting=true`, so leads land on the day they came in, like the CRM. The UI tooltip says so: "Counted on the day the lead came in, like ProdigyFlo. Ads Manager's default view counts the day the ad was seen, so its lead number can differ slightly." Spend is unaffected.
- Ad-level window insights are paged with `getAllPages` (limit 500), **never** inside a batch. The 5 account-level windows may go in one batch, since each returns one row.
- `MAXIMUM` at ad level: on Meta's "reduce the amount of data" error (code 1 or 100 with that message), retry once with `time_range` = the last 37 months. If that fails too, store campaign-level MAXIMUM only and set `partial=true`. Async report jobs need a POST, so they wait until writes are approved (Later).
- Lead count rule (B4): `onsite_conversion.lead_grouped` first, otherwise `lead`. Landing-page views are `landing_page_view`.
- `ownership()` maps errors this way: allowed → `allowed`; another account → `other_account`; permission errors → `no_access`; 100/33 or a missing id → `not_found`. `other_account` is final. `no_access` and `not_found` may be temporary (a permission blip, a brand-new ad): they are cached, the touch stays pending and the ad is probed again after 6 h, until the lead is 3 days old; then it is OUTSIDE (fail closed). "Re-match leads" forgets those tentative answers.
- `MockAdsSource` is only constructible when `adsMockAllowed()`, and it uses `act_mock_<orgId prefix>`. It has 3 campaigns, 5 ad sets and 9 ads: one paused and never delivered, one archived, and one Advantage+ creative using `asset_feed_spec`. The balance sawtooth includes a payment every 3 simulated days, a stale-replica flap and a bounce.

### 3.3 Sync (`sync.ts`)

`syncAllOrgs({ budgetMs })`:

- If there is no binding, return `{ adAccounts: 0, reason: 'not_configured' }`.
- Otherwise run `syncAdsForOrg(boundOrgId)` for each allowed account, and stop when the time budget runs out (`partial:true`).

`syncAdsForOrg(orgId, { force?, manual? })`:

1. Run `resolveAdsConfig`. If it isn't live, write nothing and return. Mock mode is the only exception, and only where `adsMockAllowed()`.
2. **Lease.** `updateMany({ where: { adAccountId, OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lt: now } }] }, data: { syncLeaseUntil: now + 280 s, syncLeaseOwner: uuid } })`. If the count is 0, return `{ skipped: 'busy' }`. Release the lease in `finally` with `where syncLeaseOwner = uuid`. Every step below runs only under the lease.
3. Skip the run when `backoffUntil > now`.
4. **Snapshot (every run, 1 Graph call):** `account()`, then insert `MetaAccountSnapshot`.
   - If `amount_spent` is lower than the last accepted reading, mark the snapshot `stale=true`, leave the cached fields and the detector alone, and stop the snapshot step.
   - Otherwise update the cached fields and run `stepChargeDetector` (§3.4).
   - Save `pendingCharge` with `updateMany where billingVersion = v`, setting `billingVersion = v+1`. If the count is 0, someone else advanced the detector: drop this run's billing step.
   - Emitted events are written with `createMany({ skipDuplicates: true })` on `@@unique([adAccountId, kind, fromSnapshotId])`.
   - On a status change: write a `STATUS_CHANGE` event and send a `Notification{kind:SYSTEM}` to the bound org's active SUPER_ADMINs. On a card change: `CARD_CHANGE`.
   - Prune snapshots older than 120 days.
5. **Full sync** when `force` is set or the last full sync is older than `META_SYNC_FULL_MINUTES`, and `lastUsagePct < 75`. After every response, `onUsage` runs; if `maxPct ≥ 75` or `regainSeconds > 0`, stop **mid-step**, set `backoffUntil = now + max(15 min, regain, reset)`, and keep what has been written.
   - Campaigns and ad sets: mirror into Campaign/AdSet with `adAccountId`. Campaigns use `findFirst({ organizationId, externalId }, orderBy createdAt asc)` and then update or create, under the lease. Rows not seen get `effectiveStatus='DELETED'`.
   - Ads: upsert MetaAd. Rows not seen get `removed=true` and are never deleted. Thumbnail URLs refresh on every full sync.
   - Window insights: account and ad level, 5 windows, into `MetaInsightSummary`.
   - Daily from day −90 to today: account level into `MetaInsightDaily`. Campaign level for the last 30 days goes into `MetaInsightDaily(CAMPAIGN)` and `CampaignDailyStat` (spend, impressions, clicks, leads).
   - Recompute `Campaign.spend/impressions/clicks` and `AdSet.spend` as before.
   - Cycle: fill `startDayExcludedSpend` from `hourly()` (spend-only fields). Only a definite "unsupported" answer (code 100) sets `spendApproximate=true`; rate, token and transient errors leave it to be retried on a later run within 48 h. Each success stamps `startDayExcludedAt`; a cycle (open or closed) still unstamped once it is 48 h old is set `spendApproximate=true`, and the page shows "about" on its spend (current card and past cycles). Recompute `closedSpend` and `closedLeads` for cycles with `finalAfter > now`; a closed cycle's end day counts only the spend before the switch hour (end-day spend minus the next cycle's `startDayExcludedSpend`), so nothing is counted twice.
   - `truncated` from any step goes to `lastTruncated`.
6. **Lead touches:** `rebuildLeadTouches(orgId, { limit: 200, probes: 50 })` (§3.6).
7. **Connection check:** once a day, or on Re-check, run `tokenInfo()`, `visibleAccounts()` and `resolveMetaOrg()`. Store `tokenValid`, `tokenAppId`, `tokenType`, scopes, `tokenSeesOthers`, `leadOrgMatches`. Nothing else is stored.
8. **Errors:** store `lastErrorKind`, `lastError` (plain copy only) and `lastErrorAt` on `MetaAdAccount`, plus `ConnectorLog{event:'meta.ads.sync.error', detail:{kind, code, subcode}}`.
   - rate or blocked: back off 15 minutes (60 for blocked);
   - token: `tokenValid=false`;
   - transient: nothing extra, the next run retries.
   - `Connector.status` is **never** changed by the ads sync.

`assertWritableObject(orgId, externalId)`: require `META_ADS_WRITES_ENABLED==='true'` and a bound org. Then require a local Campaign/AdSet/MetaAd with an allowed `adAccountId`, or else `ownership()` returning `allowed`. Otherwise throw and audit.

### 3.4 Payment detection (`billing.ts`, pure)

```ts
type Reading = { snapshotId: string; balanceCents: number; amountSpentCents: number; fundingType: number | null; at: Date }
type Pending = { fromSnapshotId: string; fromCents: number; toCents: number; fromSpentCents: number; detectedAt: string; confirmations: number; readings: number; lastAt: string }
export function stepChargeDetector(prev: Reading | null, pending: Pending | null, r: Reading):
  { pending: Pending | null; emit: { fromSnapshotId: string; amountCents: number; occurredAt: string } | null;
    event: 'off'|'stale'|'none'|'candidate'|'confirming'|'confirmed'|'bounce'|'deeper'|'expired' }
```

**Rules, in order:**

0. **Funding.** The detector runs only for card (1) or direct debit (17). Any other funding gives `off` and clears the pending charge. Prepaid and Meta-balance balances don't behave like a bill.
1. **Stale replica.** If `r.amountSpentCents < prev.amountSpentCents`, the result is `stale` and nothing changes. This covers the 8.96 → 0.03 → 8.96 flap.
2. **No pending charge.** It becomes a candidate when `prev.balance − r.balance ≥ 100` **and** `r.balance ≤ 0.6 × prev.balance`. The candidate records `fromSnapshotId = r.snapshotId` and `fromSpentCents = r.amountSpentCents`.
3. **Pending charge.** Let `spentSince = r.amountSpentCents − fromSpentCents`.
   - **deeper:** `r.balance < to − 100` sets `to = r.balance`.
   - **confirm:** `r.balance ≤ max(to + 100, 0.6 × from)` **or** `r.balance − to ≤ spentSince + 100` (the rise is explained by new spend) adds 1. When the reading comes ≥ 30 minutes after `lastAt` and is still low, it adds 2.
   - **bounce:** `r.balance ≥ 0.9 × from` and `spentSince ≤ 100` (the balance came back without spend moving) discards the candidate.
   - At 2 confirmations, emit `{ fromSnapshotId, amountCents: from − to, occurredAt: detectedAt }`.
   - Otherwise it stays pending. After **12 readings** without confirmation it is `expired`. Wall-clock time never expires it.
4. Emitted rows are `PAYMENT`, `approximate=true`, labelled "Payment or charge, about $X". The footnote says the amount is a floor and the row can also be a manual payment, credit or refund.
5. Idempotency comes only from `fromSnapshotId` (§2.4). There is no time-window dedupe, so back-to-back genuine payments both record.

**Table tests:** a clean payment; the stale flap; a high-spend account that climbs back within the window while `amount_spent` moves (confirmed, not a bounce); a true bounce with flat spend; a drop of $0.50; a drop to 70%; a deeper drop; expiry by readings; a gap confirmation after a 90-minute outage; funding type 2 gives off; two back-to-back payments both emitted; re-running the same reading is idempotent.

### 3.5 Spend cycle

- `cycleState(startedAt, lengthDays, now, tz)` returns `{day, endsAt, overdue}`. Day 1 is the start day in the account timezone; `overdue` is `day > lengthDays`.
- `cycleSpend(dailyRows, startDay, today, startDayExcludedSpend)` = the sum of ACCOUNT daily spend from the start day through today, minus the excluded amount, floored at 0.
- Leads in a cycle = `MetaLeadTouch` rows with `status='matched'` and `leadCreatedAt ≥ startedAt`. CPL = spend / leads.
- A closed cycle stores `closedSpend`, `closedLeads` and `finalAfter = endedAt + 3 days`. The sync recomputes them until `finalAfter`, and the UI shows "final after {date}" until then.
- Keep 24 closed cycles; delete older ones. Audit `meta.cycle.started`.

"Start new cycle" closes the open cycle and creates `number+1` with `startedAt=now`, `lengthDays = MetaAdAccount.cycleDays` and `startDayExcludedSpend = 0` (filled by the next sync). It runs in a transaction under a `SELECT ... FOR UPDATE` on the account's open cycle. `@@unique([adAccountId, number])` turns a double click into a clean error, "A new cycle was just started."

### 3.6 Lead touches and funnel (`touches.ts`, `funnel.ts`)

`rebuildLeadTouches(orgId)` only runs for the bound org:

1. Read `Client.leadAttribution` and `CallCenterLead.leadAttribution` where `provider='meta'` in the bound org, newest first, for rows whose touch is missing or `pending`.
2. With an `adId`:
   - a local MetaAd with an allowed account → `matched`, storing the external ids;
   - otherwise use the `MetaObjectAccount` cache;
   - otherwise call `ownership(adId)` (at most 50 per run) and cache the answer. `allowed` → `matched`; anything else → `outside`, with all ids nulled.
   - Anything not yet probed stays `pending`.
3. No `adId`, or no attribution at all (every lead from before 0b03c61) → `unmatched`.
4. Recompute `outsideLeadCount`.

There are no Graph lead reads, no `leads_retrieval`, and nothing depends on Meta's 90-day lead retention.

**Funnel (`funnel.ts`, pure, plus a loader in `read.ts`):**

- **Inputs:** matched touches (`adId`, `clientId`, `callCenterLeadId`, `leadCreatedAt`). For each client: `firstContactAt`; whether any Appointment is not CANCELLED; whether any Appointment is COMPLETED or `StageHistory` reached PRESENTATION_COMPLETED; `Deal.status==='WON'`; `Deal.value`. For call-center-only leads: `CallCenterLead.tries > 0` means contacted, and status BOOKED means booked.
- **Stages:** sold ⇒ sat ⇒ booked ⇒ contacted.
- **Spend per ad** comes from the MetaInsightSummary AD row for the window (7d → LAST_7D, 30d → LAST_30D, all → MAXIMUM). The touch date filter uses the same window in the account timezone. The remainder row's spend counts in the totals, never against an ad.
- Ad and campaign names come from the synced MetaAd and Campaign rows, never from lead JSON.
- Cost per X = spend / X (null on 0). ROAS = revenue / spend.
- `attributionDoubt(crm, meta)`: `|crm − meta| > max(1, 0.2 × max(crm, meta))`. Both counts are by conversion time, so the doubt is no longer triggered by a date-basis mismatch.
- `attributionBroken(rows)`: one ad holds more than 80% of CRM leads while Meta credits it with less than 50%, with at least 4 CRM leads and at least 4 Meta leads.

### 3.7 Legacy and foreign rows in existing consumers (`where.ts`)

```ts
export function allowedMetaCampaignWhere(orgId: string): Prisma.CampaignWhereInput
// { organizationId: orgId, OR: [ { channel: { not: 'meta' } }, { channel: 'meta', adAccountId: { in: allowedAccountsForOrg(orgId) } } ] }
export function allowedMetaAdSetWhere(orgId: string): Prisma.AdSetWhereInput            // adAccountId IN allowedAccountsForOrg(orgId)
export function allowedCampaignDailyStatWhere(orgId: string): Prisma.CampaignDailyStatWhereInput // { campaign: allowedMetaCampaignWhere(orgId) }
```

- Rows with `adAccountId` NULL (everything that exists before the migration, including workspace-merge rows and `MockMetaAdsProvider` rows) and `act_mock_*` rows outside mock mode are therefore hidden everywhere.
- Apply it in:
  - `marketing-metrics.ts` `getMarketingOverview`;
  - `analytics.ts` `getCampaignPerformance`;
  - `revops.ts` `getAttributionReport`;
  - `index.ts` `monthSpend` and `campaignTrends`;
  - `ops.ts` `resolveTarget` and the `fb>` console `list`;
  - the `/marketing/meta` `?campaign=` lookup;
  - `ingestMetaLead`'s ad set → campaign lookup. A lead is linked to a local campaign, and its `utm_campaign` set, only when that campaign is allowed.
- Non-meta campaigns are untouched.
- **`scripts/meta-ads-classify-legacy.ts`** (dry-run unless `--commit`, bound org only). For each meta Campaign and AdSet with `adAccountId` NULL and a non-`mock_` externalId, call `ownership()` through the guarded client. `allowed` sets `adAccountId`. Anything else leaves it NULL, so the row stays hidden. The output is counts only, never names or ids of hidden rows. `mock_` rows are never classified in production.

### 3.8 Cheap health badges

- `zeroLeadStreakDays`: consecutive trailing days with spend > 0 and leads = 0, from CAMPAIGN daily rows (ad-level daily isn't synced), inherited by the campaign's ads.
- `highFrequency`: 7-day frequency > 2.5.
- `lowCtr`: 7-day link CTR < 1% with at least 1,000 impressions.

### 3.9 P0-A: stop storing and showing foreign attribution names (Dakota reviews, owner signs off)

This changes Dakota's merged feature. Build it on this branch as separate, small commits so it can be reviewed apart from the rest. It merges only after Dakota's review and the owner's written sign-off. The rest of P0 doesn't depend on it, but production must not go live with the dashboard while P0-A is unmerged: the connect script's `--commit` refuses until the scrub script reports 0 named rows.

1. **Ingest keeps ids only.** In `attribution.ts`, `storedAttribution()` writes `adName`, `adsetName` and `campaignName` as `null`. `GRAPH_LEAD_FIELDS` asks for ids only (`ad_name`, `adset_name`, `campaign_name` were removed after review: a lead on the shared Page can come from another account's ad, so its names are never fetched), and `attributionFromGraph` always sets the three names to null.
2. **Names at read time.** `attributionRowsFor(orgId, raw)` in `src/lib/meta/ads/attribution-names.ts` looks up Campaign, AdSet and MetaAd by external id through the §3.7 fragments. It calls `attributionRows(raw, names)`, which gets an optional second argument in `attribution.ts`:
   - Campaign, Ad set and Ad rows appear only when their id resolves to an allowed row, as `name (id)`.
   - Ids that don't resolve show nothing. If none resolve: one row with no id, "Ad: Outside the connected ad account" only when that is proven (the touch is outside, or Meta said the ad is in another account), else "Ad: Not matched to an ad yet". A workspace with no ads reporting gets no ad rows.
   - Platform, Form, Organic, Lead state and Leadgen id stay as they are.
   - Called with no second argument, `attributionRows` never shows Campaign, Ad set or Ad, so it fails closed.
   - Callers switch to the server helper: `src/lib/daily-desk-case.ts` (final desk) and the client page that feeds `src/components/client/overview-tab.tsx` and `case-file-client.tsx`. Those components receive rows, not raw JSON.
3. **utm_campaign.** Remove the `lead.attribution?.campaignName` fallback in `ingestMetaLead`. `utm_campaign` comes only from an allowed local campaign.
4. **Backfill.** `scripts/meta-attribution-scrub.ts` is dry-run unless `--commit`, and covers every org:
   - null out the three name keys in `Client.leadAttribution` and `CallCenterLead.leadAttribution`;
   - remove `utm_campaign` / `utmCampaign` from EVERY submission of a Meta Lead Ads source (any status, with or without a client) unless it is the name or utmCampaign of an allowed local campaign;
   - null `Client.utmCampaign` when it equals a value removed above, the client's stored campaign name, or the name/utmCampaign of a hidden Meta campaign the client is linked to (legacy links);
   - for those legacy links, take the campaign name out of the pinned Instant Lead Ignition note and null `campaign` on `meta.lead_ignited` audit rows;
   - drop `utmCampaign` from the `after` of `intake.client_matched` / `intake.client_created` audit rows written by a Meta source;
   - every one of these counts toward `named`, so the connect gate stays closed until they are scrubbed.
   - It prints counts per table, never names, and is idempotent.
5. **Tests** (`tests/meta-attribution-names.test.ts`, DB): a fixture lead whose ad belongs to the fake foreign account goes through `POST /api/meta/leads` (mocked Graph returns names).
   - The names appear in no DB column, no `attributionRowsFor` output and no `IntakeSubmission.payload`.
   - An allowed-account lead shows the synced names.
   - `tests/meta-webhook-attribution.test.ts` is updated **only** where it asserted stored names, and the change is called out for Dakota.

### 3.10 Backend tests (vitest; DB tests follow `tests/meta.test.ts`)

- `allowlist.test.ts`: normalization incl. `act%5F`; both vars required; unbound org; `refFor` contains no digit run from the id; `adsMockAllowed` false under `VERCEL_ENV=production` and the prod hosts.
- `graph-client.test.ts` (mocked `fetchImpl`). One test per bypass, each asserting `fetch` was never called:
  - `/{campaign_id}/insights` for an unknown or foreign id;
  - `/{adset_id}/ads`;
  - `/{ad_id}?fields=...` (anything other than `account_id`);
  - `ids=1,2,3`;
  - a batch `relative_url` with an object id;
  - `me?fields=adaccounts{...}`;
  - `{business}?fields=owned_ad_accounts{...}`;
  - `{business}/client_ad_accounts`;
  - URL-encoded `act%5F`;
  - a version prefix inside a batch `relative_url`.
  - Plus:
    - a response row with a foreign `account_id` is dropped and audited;
    - `myAccounts` returns no foreign ids;
    - the token is in the header only;
    - the proof is sent only when `tokenAppId == appId`;
    - paging with limit 500 and `truncated`;
    - the classification table (190/463/460/458/467, 102, appsecret_proof, 1, 2, 368, 4, 17, 32, 613, 80004, 429, 10, 200, 100/33);
    - errors contain no token or proof;
    - usage is parsed after every response.
- `metrics`, `creative`, `tree` tests. The tree test includes the archived ad and the remainder row, and asserts that the tree sum equals the account total.
- `billing.test.ts`: the §3.4 table.
- `cycle.test.ts`: DST, overdue, excluded spend, floor, restatement until `finalAfter`.
- `funnel.test.ts` and `touches.test.ts`:
  - matched / outside / unmatched / pending;
  - permission, 100/33 and missing all count as outside;
  - pre-0b03c61 leads count as unmatched;
  - outside touches carry no ids.
- `tests/meta-ads-sync.test.ts` (DB):
  - **two orgs with env creds set: org B gets no Graph call, no rows and `not_connected` from every read.ts view**;
  - a full sync from fixtures writes `adAccountId` on everything;
  - **two parallel `syncAdsForOrg` calls give one emit and no duplicate Campaign, MetaAd or billing rows**;
  - **production env with no creds: the sync writes nothing and the dashboard reads `not_connected`**;
  - a 190 leaves `Connector.status` unchanged;
  - rate back-off stops mid-sync;
  - writes are refused when off, and refused for a foreign object when on;
  - `createAdAccount` throws.
- `tests/meta-ads-serialize.test.ts`: `JSON.stringify` of each view over seeded BigInt and Decimal rows.
- **`tests/meta-ads-leak-canary.test.ts`** (DB). Seed:
  - the fake foreign `act_999000111222333` in every new table and in `Campaign`, `AdSet`, `CampaignDailyStat`;
  - foreign ad, ad set and campaign names and ids inside `leadAttribution` JSON;
  - NULL-account legacy rows;
  - `act_mock_*` rows.

  Then call every read.ts view, `getMarketingOverview`, `getCampaignPerformance`, `getAttributionReport`, `monthSpend`, `campaignTrends`, `ops.resolveTarget`, the console `list`, `attributionRowsFor` and the daily-desk case. Assert that the serialized output contains none of the foreign digits, names or spend.
- **`tests/meta-ads-repo-ids.test.ts`**: fails if any `act_\d{15,16}` other than `act_1742876583597558` and `act_999000111222333` appears under `src`, `docs`, `tests` or `tools`. It also pins the route files under `src/app/api/meta/**` and `src/app/api/jobs/**`.
- Lead path unchanged: `tests/meta-webhook-attribution.test.ts` and `tests/meta.test.ts` stay green. A new assertion checks that the webhook's outbound Graph request (path, query keys, token placement) equals the pre-change one, apart from the version segment.
- `src/lib/final-desk/routes.test.ts`: SUPER_ADMIN is allowed under final desk; CLOSER is denied.
- `tests/meta-ads-connect.test.ts`: the exported core is idempotent, refuses every §5.1 condition, and writes nothing without `--commit`.

## 4. UI scope (`src/app/(app)/**`; reuse `src/components/**`)

Read `node_modules/next/dist/docs/01-app/01-getting-started/{05-server-and-client-components,07-mutating-data,10-error-handling}.md` first.

### 4.1 Page `/marketing/meta`

`page.tsx` reads **only** from `src/lib/meta/ads/read.ts`; no provider calls in render. Search params: `view` = `overview` (default) | `ads` | `funnel` | `cycle` | `billing` | `connection`; `w` (window, overview and ads); `range` (funnel); `campaign` (looked up through `allowedMetaCampaignWhere`). Billing and Connection tabs appear only with `connectors:manage`; asked for without it, the page shows the existing forbidden pattern.

- **Header:** `PageHeader` "Meta Ads", subtitle `{account.name} · {adAccountId}`; mode badge; "Updated {relativeTime(lastFullSyncAt)}" and a warning Badge "Numbers may be out of date" when `stale`; "Refresh now" (manage; `useTransition` + sonner toast); under final desk a "Back to board" link to `/board`; `MarketingTabs` when the sidebar layout is active.
- **Sync errors:** a top `Alert` with the plain copy from §2.3; the token kinds link to the Connection view. Old numbers stay visible, labelled as from the last good sync. Never show zeros as if real.
- **Overview:** window picker (Today, 7 days, 30 days, This month, All time) as links; KPI tiles via the existing `KpiTile`/stat tile (Spend, Leads, Cost per lead, CTR, CPC, CPM, Reach, Frequency, "—" for null); `TrendChart` of spend and leads over 30 days incl. today; account card (name, status pill, balance, card, lifetime spent, cap); counts row.
- **Ads:** campaign → ad set → ad tree. Desktop extends `campaign-table.tsx` with an expandable ad level (`min-w-[64rem]` scroll only at `md+`); phone uses a stacked `Card` list with `Collapsible`. Ad rows: thumbnail, name, status, Spend / Leads / CPL / CTR, badges "No leads {n} days", "Seen too often", "Low click rate", each with a `Tooltip`. Tapping an ad opens a `Sheet` with the creative summary (headline, body, CTA, link host only). Write controls render only when `writesEnabled`; otherwise "Changes are made in Meta Ads Manager."
- **Funnel:** range tabs (7 days / 30 days / All); table by ad (Spend, Meta leads, CRM leads, Contacted, Booked, Showed, Sold, Revenue, cost per lead/booking/show/sale, ROAS); "Numbers disagree" Badge on `attributionDoubt`; a top `Alert` on `attributionBroken`: "One ad is getting credit for most leads in ProdigyFlo but not in Meta. Check that the lead form is only used by one ad."; the existing `funnel-chart.tsx` for totals.
- **Cycle:** "Cycle {n} · day {d} of {N}", start and end in the account timezone, Overdue Badge, spend, leads, CPL, "about" marker when approximate; "Start new cycle" (manage) behind a confirm `Dialog` ("This closes cycle {n} at {spend} and starts cycle {n+1} now."); cycle length `Input` (manage); history `Table` of the last 6; empty state "No cycle started yet".
- **Billing** (manage): account card; "Unpaid balance" with "Meta charges the card when this reaches the billing threshold or on the billing date."; 90-day spend bar chart; ledger `Table` (Date, What happened, Amount); pending line "Possible payment of about $X, confirming…"; "Open billing in Meta" link.
- **Connection** (manage): a checklist with `CheckCircle2`/`X` icons: mode; allowlist (only allowed ids, Reachable / Not reachable); token valid, expiry ("Never expires" when null), scopes as Badges; last full sync, last snapshot, usage %, back-off; the last 5 errors in plain English; writes on/off; "Re-check now"; "Re-match leads to ads".
- `error.tsx`: client component, "We couldn't load the ads page." plus "Try again" `reset()`; no stack, no ids. `loading.tsx`: extend the skeleton to the tabs.

### 4.2 Files and look

- Edit `page.tsx`, `campaign-table.tsx`, `meta-islands.tsx`. New: `ads-actions.ts`, `views/{overview,ads-tree,funnel,cycle,billing,connection}.tsx`, `window-tabs.tsx`, `refresh-button.tsx`, `error.tsx`.
- Only shadcn components from `src/components/ui`, `PageHeader`, `EmptyState`, `src/components/charts`, the `src/lib/format.ts` helpers (`currency`, `number`, `percent`, `relativeTime`, `dateTime(…, account.timezoneName)`) and the `globals.css` tokens, which give light and dark mode. No hard-coded colors except chart series tokens. ProdigyFlo branding comes from the existing org-brand map; no other logo or name apart from Meta's own account name.
- Phone: 16 px gutters, no horizontal page scroll, tap targets ≥ 40 px. Copy in plain English, sentence case, with a tooltip on any jargon ("CTR": "Share of people who clicked after seeing the ad").

### 4.3 Separation, honesty and safety rules in the UI

- **Not the bound org.** An `EmptyState` reads "Meta Ads reporting isn't connected for this workspace." There is no account name, no id and no numbers.
- **Mode badge.** Live / Sample data (dev and preview only) / Not connected.
- **Ads view:**
  - archived or removed ads show a muted "Removed" badge;
  - the remainder row reads "Removed or archived ads" with a tooltip;
  - thumbnails use a plain `<img alt loading="lazy" referrerPolicy="no-referrer">` with an `onError` placeholder; never `next/image`, never proxied or stored.
- **Funnel:**
  - footer lines: "Not matched to an ad: N" (this includes leads from before attribution was captured), "From ads outside SCS General 1 (hidden): N" and "Still being checked: N";
  - a red `Alert` when `leadOrgMatches` is false: "Meta leads arrive in a different ProdigyFlo workspace, so this funnel can't match them.";
  - the Leads tooltip uses the conversion-time wording from §3.2.
- **Billing:**
  - ledger wording "Payment or charge, about $X";
  - footnote: "Worked out from balance drops. Amounts are a floor, times are within about 10 minutes, and a row can also be a manual payment, credit or refund.";
  - when `detector='off_funding'`: "This account isn't paid by card, so payments aren't tracked here."
- **Cycle:** "final after {date}" on recently closed cycles.
- **Connection.** These items show red (`X`, destructive tone) and are never soft notes:
  - token app doesn't match ProdigyFlo's app;
  - token type isn't a system user;
  - ads permissions not limited to the approved account;
  - "This token can also reach other ad accounts. Remove them from the ProdigyFlo system user in Meta Business Settings.";
  - lead workspace mismatch;
  - some rows weren't loaded (`truncated`).

  The webhook URL and verify token are no longer shown here; they stay on the intake connector surface.
- `meta-console.tsx` stays hidden unless `writesEnabled`. The AdAccountDialog trigger is removed.
- `src/components/final-desk/final-desk.tsx`: the one-line `ads` entry for `isAdmin`. That file was touched in 0b03c61, so keep the hunk to those lines. "Ads" / "Anuncios" go in `ui-copy`.
- **Checks:** typecheck, lint and build, plus screenshots at 390 and 1440 px, light and dark, in the scratchpad (not committed). The "no foreign id" guarantee is enforced by the leak canary. Screenshots are a manual second look only.

## 5. Connect script and live setup for the DA

### 5.1 `scripts/meta-ads-connect.ts` (tsx)

`connectMetaAds({ orgId, adAccountId, commit, check, startCycle })` is exported and wrapped by a CLI:

```
npx tsx scripts/meta-ads-connect.ts --org-id <Organization.id> --account act_1742876583597558 [--check] [--start-cycle] [--commit]
```

1. **Print** every live org (id, slug, name, deletedAt=null), whether it has a META_ADS connector, which intake and ads field **names** are present (no values), whether it has an enabled META_LEAD_ADS source, and the org `resolveMetaOrg()` returns. Also print `META_ADS_ORG_ID` and `META_ALLOWED_AD_ACCOUNTS` as configured. Without `--org-id`, stop after printing.
2. **Refuse `--commit` unless** all of these hold:
   - `META_ADS_ORG_ID == --org-id`;
   - `--account` is in `META_ALLOWED_AD_ACCOUNTS`;
   - `--org-id == resolveMetaOrg()`;
   - no other org holds a `MetaAdAccount` row for the account;
   - the attribution scrub reports 0 named rows (§3.9).
3. **`--check`** (read-only Graph through the guarded client, using the one-source ads credentials from `resolveAdsConfig`):
   - `debug_token` with the token itself prints `is_valid`, `app_id`, `type`, expiry, and whether the `granular_scopes` target_ids for `ads_read` (and `ads_management`, if present) are a subset of the allowlist. Ids outside it are shown only as a count;
   - `GET act_…?fields=name,currency,account_status,timezone_name`;
   - `myAccounts`, which prints "token sees other accounts: yes/no".
   - It also prints whether the ads app id equals the intake app id, as information only.
4. **`--commit` additionally refuses unless:**
   - `app_id` equals the app id of the ads credential set in use (vault `adsAppId` when the vault holds the set, else `META_ADS_APP_ID`);
   - `type == 'SYSTEM_USER'`;
   - the `ads_read` target_ids, when listed, are a subset of the allowlist (no list on a non-system-user token = "all accounts" and is refused; no list on a SYSTEM_USER token is "not reported" and judged by `me/adaccounts`);
   - the token sees no other account.
5. **Commit:**
   - upsert `MetaAdAccount` (`cycleDays = META_ADS_CYCLE_DAYS`);
   - with `--start-cycle` and no open cycle, create cycle 1;
   - audit `meta.ads.connected` with `actorLabel:'script:meta-ads-connect'`.
   - A rerun prints "Already connected" and changes nothing.
   - The script never writes the token. The token goes in through Connectors → Meta Ads (the ads fields) or the env.

### 5.2 Live setup (DA, in order; nothing here is done by the builders)

Final names, as built. Scripts import `server-only` modules, so every script runs as `npx tsx --conditions=react-server scripts/<name>.ts`.

**Environment (Vercel → Production):**

| Name | Value | Notes |
|---|---|---|
| `META_ADS_ORG_ID` | the `Organization.id` from step 3 | Never a slug. With this unset nothing is bound and every workspace reads "not connected". |
| `META_ALLOWED_AD_ACCOUNTS` | `act_1742876583597558` | The only account. One malformed entry fails the whole list closed. |
| `META_ADS_APP_ID` | ProdigyFlo's own Meta app id | Only if the set is NOT in the vault. The token's `app_id` must equal the in-use set's app id (checked by `--commit`). |
| `META_ADS_APP_SECRET` | that app's secret | Only if the set is NOT in the vault. Used only for `appsecret_proof`, and only when the token's app matches. |
| `META_ADS_SYSTEM_USER_TOKEN` | the ads-only system user token | Only if the token is NOT in the vault. Vault set (Connectors → Meta Ads → "Ads app ID", "Ads app secret", "Ads System User token") wins as a whole; never fill both. |
| `META_GRAPH_VERSION` | `v25.0` | Optional; that is the default. |
| `CRON_SECRET` | already set | `/api/jobs/meta-sync` also accepts `JOBS_TOKEN`; refuses everything when neither is set. |
| `META_ADS_WRITES_ENABLED` | leave unset | Writes (pause, budget) stay off; the page says "Changes are made in Meta Ads Manager." |
| `META_SYNC_FULL_MINUTES`, `META_ADS_CYCLE_DAYS` | leave unset | Defaults 30 and 15. |

The cron is the new `vercel.json` entry `/api/jobs/meta-sync` every 10 minutes (needs the Vercel plan that already runs `/api/jobs/run` every 5).

**Steps:**

1. **Owner sign-offs first:** P0-A (§3.9) after Dakota's review, then the merge and deploy of this branch. The migration `20261008120000_meta_ads_scs` is additive (new tables and enums, nullable columns, indexes) and `prisma migrate deploy` runs in the normal release.
2. **Meta Business Settings** (the business that owns SCS General 1):
   - On **ProdigyFlo's own Meta app** (not any app another system uses), create a **new** system user, e.g. `prodigyflo-ads`.
   - Assign it **only** SCS General 1 with *View performance*.
   - Generate a never-expiring token with `ads_read` (plus `read_insights`) and nothing else: no `business_management`, no Page, leads or `ads_management` permissions.
   - Never reuse a token or system user that another system uses, and don't change the existing lead webhook.
3. **Find the org id:** `npx tsx --conditions=react-server scripts/meta-ads-connect.ts` (no flags) from a machine with the production `DATABASE_URL`. Read-only. Note the org that `resolveMetaOrg()` returns; that is `META_ADS_ORG_ID`.
4. **Set the env** from the table above (or the token in the vault form), then redeploy.
5. **Scrub:** `npx tsx --conditions=react-server scripts/meta-attribution-scrub.ts` (dry run, counts only), then the same with `--commit`. Re-run the dry run: it must report 0 named rows, or step 6's `--commit` refuses.
6. **Connect:** `... scripts/meta-ads-connect.ts --org-id <id> --account act_1742876583597558 --check`, read the debug_token lines (app matches, `SYSTEM_USER`, ads_read targets inside the allowlist, "token sees other accounts: no"), then `--commit --start-cycle`. A rerun prints "Already connected".
7. **Legacy rows:** `... scripts/meta-ads-classify-legacy.ts` (dry run), then `--commit`.
8. **First sync:** `curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/jobs/meta-sync`. Expect `"adAccounts":1,"partial":false`. Then open `/marketing/meta?view=connection` as Super Admin (under the final desk: the "Ads" button in the rail). Every item green: token valid and app matches, system user, scopes limited, sees no others, lead workspace matches, last sync within 10 minutes.
9. **Real Chrome:** every view at phone and desktop width, light and dark. 30-day spend should match Ads Manager within rounding; leads may differ slightly (conversion time). Billing shows the VISA on file. Sign in to any other workspace, if one exists, and confirm "Meta Ads reporting isn't connected for this workspace."
10. **Watch 24 hours:**
    - no phantom ledger rows;
    - about 144 snapshots a day;
    - usage under 50%;
    - no `meta.ad_account.refused` audit rows apart from expected ones.

**Rollback:** unset `META_ADS_ORG_ID` (or `META_ALLOWED_AD_ACCOUNTS`) and redeploy. Every workspace reads "not connected", the cron syncs nothing and no ads Graph call happens. Lead intake is untouched either way.

## 6. Order of work and checks

1. **BACKEND:** schema and migration, then allowlist, graph-client, pure libs, sources, sync, read and `where.ts`. Then the consumer edits, the route and the scripts, then P0-A as separate commits. Gates:
   - `npx prisma generate`;
   - migrations on a throwaway local DB only;
   - `npx next typegen && npm run typecheck`;
   - `npm run lint`;
   - `npm test` (DATABASE_URL, AUTH_SECRET, VAULT_KEY);
   - `npm run build`.
2. **UI** against the `read.ts` types, with the same gates plus the screenshots.
3. Builders make no commits to main, no pushes, no deploys, no live Graph calls and no remote DB access.

## 7. Later (not P0)

- Move the legacy token-in-query paths (`graph.ts` `graph()`, `instagram.ts`, `tools/meta-lib.mjs`) to the Authorization header, and `tools/meta-lib.mjs` to `META_GRAPH_VERSION`. Coordinate with Dakota, since they carry the live lead path.
- Drop `ad_name`, `adset_name` and `campaign_name` from `GRAPH_LEAD_FIELDS` once Dakota agrees (P0-A already stops storing them).
- Gate CRM ingestion of leads whose ad is outside the allowlist (acknowledged to Meta, not ingested, audited). This needs owner sign-off because it changes lead routing.
- Partial unique index on `Campaign(organizationId, externalId) WHERE externalId IS NOT NULL`, after a production duplicate check.
- Async insight report jobs for very large MAXIMUM windows (needs POST).
- Scores, analyst text, speed alerts; funnel by form answer; preview iframe and video; ad lab; Conversions API; email or SMS billing alerts; multi-account compare.

## Review log

**2026-10-08, revision 2** (resumed run; base moved from 39bb0dc to 0b03c61). Each review finding and where it is resolved:

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | critical | Global allowlist leaks across orgs | Decision 1; `META_ADS_ORG_ID`; `MetaAdAccount.adAccountId @unique`; bound-org checks in config, sync, read, provision (§2.2); two-org DB test (§3.10). |
| 2 | critical | 0b03c61 stores and shows foreign ad, ad set and campaign names | P0-A (§3.9): ids-only storage, read-time names from allowed rows, utm fallback removed, scrub script, tests; Dakota review plus owner sign-off. |
| 3 | high | MetaLeadTouch re-read leads from Graph | Decision 6; `leads()` removed; touches built from stored JSON; `MetaObjectAccount` ownership cache; fail-closed outcomes; pre-0b03c61 leads unmatched (§3.6). |
| 4 | high | Negative regex allowlist bypassable | Positive typed route table, fixed field constants, decode-until-stable, response-side `account_id` drop, one test per bypass (§2.3, §3.10). |
| 5 | high | Legacy and foreign rows shown by other consumers | `where.ts` fragments in every listed consumer plus `?campaign=` and ingest; classify-legacy script; leak canary (§3.7, §3.10). |
| 6 | high | Editing graph() would change the live lead webhook | Decision 8; `graph()` and `fetchLead` untouched; proof only when the debug_token app matches; `config` error kind; outbound-request test (§3.1, §3.10). |
| 7 | high | Token and app may be shared; vault/env mixing | Decision 4; separate ads fields and env; one source, never mixed; debug_token checks block `--commit`; red Connection items; catalog placeholders replaced (§5.1, §4). |
| 8 | high | Mock can run in production | Decision 9; `adsMockAllowed()`; `DisconnectedMetaAdsProvider`; mock ids hidden; production no-creds test. |
| 9 | high | Concurrent syncs race | Lease, `billingVersion`, `@@unique([adAccountId, kind, fromSnapshotId])`, campaign mirroring under the lease, parallel-sync test (§3.3, §2.4). |
| 10 | medium | Charge detector false positives and negatives | Rewritten §3.4: stale-replica guard on amount_spent, spend-aware bounce, expiry by readings, gap confirmation, card and direct debit only, "Payment or charge" label, table tests. |
| 11 | medium | Insight pitfalls | limit 500 and paging outside batch, MAXIMUM fallback, archived ads plus `removed` flag plus remainder row, conversion-time attribution (§3.2, §3.3). |
| 12 | medium | Lead org may differ from ads org | Decision 2; bound org must equal `resolveMetaOrg()`; script refuses; runtime red item; WORKSPACE-CLEANUP not treated as fact. |
| 13 | medium | Scopes too wide | ads_read (+ read_insights) on SCS General 1 only; catalog copy updated (§5.2, §3.1). |
| 14 | medium | Ads errors flip the intake connector; incomplete error kinds | Decision 10; health on MetaAdAccount; full kind table incl. config, transient, blocked and 190 subcodes; usage checked after every response (§2.3, §3.3). |
| 15 | medium | Audit ref shows digits of the foreign id | `refFor` hash-only; no deny-list var; repo id canary (§2.2, §3.10). |
| 16 | medium | Actions and routes exposed | Each action self-gates and takes no ids; DB-backed refresh limit; no new routes under /api/meta or /api/jobs except the cron; route-pin test (§2.6). |
| 17 | low | BigInt/Decimal can't cross to client | Serialization boundary in read.ts plus a stringify test (§2.5). |
| 18 | low | Thumbnails expire; next/image unconfigured | Plain `<img>` with onError, refreshed on each full sync, never stored (§4). |
| 19 | low | Closed cycles freeze restated spend | `finalAfter`; recompute for 3 days; "final after" label (§3.5). |
| 20 | low | Stale base and merge friction | Base 0b03c61; migration `20261008120000_meta_ads_scs`; constant-only version swap; back-relations in one block; one new cron element; token-in-query moved to Later. |
| 21 | low | Untestable checks | `tests/meta-ads-leak-canary.test.ts` across every surface; screenshots kept as a manual check only. |

**Revision 1** (2026-10-07, base 39bb0dc): first contract. Superseded by revision 2.

## Build log

**2026-10-08, integration pass** (after the BACKEND and UI builds, base 0b03c61, nothing committed):

- `ads-actions.ts` is now a thin wrapper: each action calls `requirePermission('connectors:manage')`, then the matching `*Core` in `src/lib/meta/ads/manage.ts` (which checks the bound workspace and writes the audit row), then `revalidatePath`. One copy of each rule.
- Cycle length applies to the open cycle and every later one (UI copy and `setCycleLengthCore` now agree).
- The rate-limit message keeps its `{time}` placeholder in storage; the page fills it in the viewer's format (it used to show a raw ISO time).
- Campaign and ad set status falls back to upper case (`ACTIVE`/`PAUSED`), so status badges and write toggles read the synced rows correctly.
- P0-A handoffs done: the client overview tab uses `attributionRowsFor`; the client overview "Campaign" row and the client CSV export hide Meta campaigns outside the allowlist (`visibleCampaignName` in `where.ts`).
- Final desk "Ads" label moved to `UI_COPY.nav.ads` (EN "Ads", ES "Anuncios").
- In sample mode the Connection checklist shows the unbound items as "not checked yet" instead of red problems.
- New tests: `tests/meta-ads-manage.test.ts` (5) and `src/lib/meta/ads/where.test.ts` (3).
- Checks: `npx prisma generate`, `npx next typegen`, `npm run typecheck` clean; `npm run lint` 0 errors (1 existing warning in `final-desk.tsx`); `npm test` 142 files / 1412 tests pass; `npm run build` passes (3 existing tracing warnings from the deploy console).
- Views rendered from mock data to static HTML with the built CSS and checked in Chrome at 1440 px light/dark and in 390 px frames: no horizontal page scroll in any view or theme. The live, signed-in page was not opened (it needs a sign-in); do that in step 9 above.
