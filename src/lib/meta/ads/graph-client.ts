import 'server-only'
import { createHmac } from 'node:crypto'
import { db } from '@/lib/db'
import {
  AdAccountNotAllowedError, adsBinding, auditRefusal, decodeStable, isBoundOrg,
  normalizeAdAccountId, refFor,
} from './allowlist'

/**
 * The only way ads code reaches Graph (docs/META_ADS_SCS.md §2.3).
 *
 * Callers pass a typed Route, never a path or a field string. The client builds
 * the URL itself from fixed constants, so `ids=`, field expansions on other
 * nodes, business edges, version prefixes and encoded paths cannot be expressed.
 * Every route is checked against the workspace binding and the allowlist BEFORE
 * fetch, and every returned row must carry an allowed account_id, or it is
 * dropped and audited by hash.
 *
 * The token travels in `Authorization: Bearer` only. Errors carry plain English
 * copy, never the token, a URL, the proof or Meta's raw message.
 */

type Env = Record<string, string | undefined>

export const DEFAULT_GRAPH_VERSION = 'v25.0'

export function graphVersion(env: Env = process.env): string {
  const v = (env.META_GRAPH_VERSION ?? '').trim()
  return /^v\d+\.\d+$/.test(v) ? v : DEFAULT_GRAPH_VERSION
}

/** 'https://graph.facebook.com/' + version (no trailing slash). */
export function graphBase(env: Env = process.env): string {
  return `https://graph.facebook.com/${graphVersion(env)}`
}

// ── Fixed field sets ───────────────────────────────────────────────────────────

export const ACCOUNT_FIELDS = {
  snapshot: 'id,account_id,name,currency,timezone_name,account_status,disable_reason,balance,amount_spent,spend_cap,funding_source_details',
} as const
export type AccountFields = keyof typeof ACCOUNT_FIELDS

export const CAMPAIGN_FIELDS = 'id,account_id,name,status,effective_status,objective,daily_budget,lifetime_budget,created_time'
export const ADSET_FIELDS = 'id,account_id,campaign_id,name,status,effective_status,daily_budget,lifetime_budget,optimization_goal,created_time'
export const AD_FIELDS =
  'id,account_id,campaign_id,adset_id,name,status,effective_status,created_time,' +
  'creative{id,thumbnail_url,title,body,call_to_action_type,link_url,object_story_spec,asset_feed_spec}'
export const INSIGHT_FIELDS =
  'account_id,campaign_id,adset_id,ad_id,date_start,date_stop,spend,impressions,reach,clicks,inline_link_clicks,frequency,actions'
/** Hourly breakdowns don't support unique metrics (reach, frequency): spend only. */
export const HOURLY_INSIGHT_FIELDS = 'account_id,spend'

export const OBJECT_FIELDS = { campaign: CAMPAIGN_FIELDS, adset: ADSET_FIELDS, ad: AD_FIELDS } as const
export type ObjectFields = keyof typeof OBJECT_FIELDS

const EDGE_FIELDS = { campaigns: CAMPAIGN_FIELDS, adsets: ADSET_FIELDS, ads: AD_FIELDS, insights: INSIGHT_FIELDS } as const

/** Every delivery state, archived included, so the tree can always sum to the account total. */
export const ALL_EFFECTIVE_STATUSES = [
  'ACTIVE', 'PAUSED', 'DELETED', 'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO',
  'CAMPAIGN_PAUSED', 'ARCHIVED', 'ADSET_PAUSED', 'IN_PROCESS', 'WITH_ISSUES',
] as const

/**
 * Statuses for the insights `filtering` param. Without it, ad-, ad set- and
 * campaign-level rows leave archived and deleted objects out, so their spend
 * would be missing from the per-ad and per-campaign sums. Campaigns only ever
 * carry the shorter list.
 */
export const INSIGHT_STATUS_FILTER = {
  campaign: ['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED', 'IN_PROCESS', 'WITH_ISSUES'],
  adset: ALL_EFFECTIVE_STATUSES,
  ad: ALL_EFFECTIVE_STATUSES,
} as const

const DATE_PRESETS = ['today', 'yesterday', 'last_7d', 'last_30d', 'last_90d', 'this_month', 'maximum'] as const
const LEVELS = ['account', 'campaign', 'adset', 'ad'] as const
const HOURLY_BREAKDOWN = 'hourly_stats_aggregated_by_advertiser_time_zone'

export type InsightParams = {
  level: (typeof LEVELS)[number]
  datePreset?: (typeof DATE_PRESETS)[number]
  timeRange?: { since: string; until: string }
  daily?: boolean
  hourly?: boolean
}
export type EdgeParams = Partial<InsightParams>

export type Route =
  | { r: 'account'; account: string; fields: AccountFields }
  | { r: 'edge'; account: string; edge: 'campaigns' | 'adsets' | 'ads' | 'insights'; params?: EdgeParams }
  | { r: 'object'; objectId: string; fields: ObjectFields }
  | { r: 'objectInsights'; objectId: string; params: InsightParams }
  | { r: 'ownership'; objectId: string }
  | { r: 'debugToken' }
  | { r: 'myAccounts' }
  | { r: 'write'; objectId: string; form: Record<string, string> }

// ── Errors ─────────────────────────────────────────────────────────────────────

export type GraphErrorKind = 'rate' | 'permission' | 'token' | 'not_found' | 'config' | 'transient' | 'blocked' | 'other'

export class MetaGraphError extends Error {
  readonly kind: GraphErrorKind
  readonly code?: number
  readonly subcode?: number
  readonly status: number
  readonly plain: string
  constructor(kind: GraphErrorKind, plain: string, status: number, code?: number, subcode?: number) {
    super(plain)
    this.name = 'MetaGraphError'
    this.kind = kind
    this.plain = plain
    this.status = status
    this.code = code
    this.subcode = subcode
  }
}

const RATE_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80004, 80014])
const PERMISSION_CODES = new Set([10, 200, 294, 272])

export const PLAIN = {
  token463: 'The Meta ads token expired. Generate a new System User token and save it in Connectors → Meta Ads.',
  tokenRevoked: 'The Meta ads token was signed out or revoked. Generate a new System User token.',
  token458: 'The ProdigyFlo app was removed from the system user. Re-add it in Meta Business Settings, then generate a new token.',
  tokenOther: 'Meta says the ads token is no longer valid. Generate a new System User token.',
  config: "The ads token and the app secret don't belong to the same Meta app. Check Connectors → Meta Ads.",
  proofRequired: 'This Meta app requires the app secret on every call. Save the ads app secret in Connectors → Meta Ads.',
  permission: 'Meta refused access. The ProdigyFlo system user needs View performance on SCS General 1.',
  rate: 'Meta asked us to slow down. Numbers will refresh after {time}.',
  blocked: "Meta has temporarily blocked these requests. We'll try again later.",
  notFound: "Meta couldn't find that item.",
  transient: "Meta had a temporary problem. We'll retry on the next sync.",
  other: "Meta didn't answer as expected. We'll retry on the next sync.",
} as const

export function classifyGraphError(
  status: number,
  err: { code?: number; error_subcode?: number; message?: string } = {},
): { kind: GraphErrorKind; plain: string } {
  const code = typeof err.code === 'number' ? err.code : undefined
  const sub = typeof err.error_subcode === 'number' ? err.error_subcode : undefined
  const msg = typeof err.message === 'string' ? err.message : ''
  if (code === 190) {
    if (sub === 463) return { kind: 'token', plain: PLAIN.token463 }
    if (sub === 460 || sub === 467) return { kind: 'token', plain: PLAIN.tokenRevoked }
    if (sub === 458) return { kind: 'token', plain: PLAIN.token458 }
    return { kind: 'token', plain: PLAIN.tokenOther }
  }
  if (code === 102) return { kind: 'token', plain: PLAIN.tokenOther }
  if (code === 100 && /appsecret_proof/i.test(msg)) {
    // "Invalid appsecret_proof": token and secret are from different apps.
    // "requires an appsecret_proof argument": the proof was missing.
    return { kind: 'config', plain: /invalid/i.test(msg) ? PLAIN.config : PLAIN.proofRequired }
  }
  if (code === 100 && sub === 33) return { kind: 'not_found', plain: PLAIN.notFound }
  if (code === 368) return { kind: 'blocked', plain: PLAIN.blocked }
  if ((code !== undefined && RATE_CODES.has(code)) || status === 429) return { kind: 'rate', plain: PLAIN.rate }
  if ((code !== undefined && PERMISSION_CODES.has(code)) || status === 403 || /permission|not authorized/i.test(msg)) {
    return { kind: 'permission', plain: PLAIN.permission }
  }
  if (code === 1 || code === 2 || status >= 500) return { kind: 'transient', plain: PLAIN.transient }
  return { kind: 'other', plain: PLAIN.other }
}

/** Meta's "Invalid appsecret_proof" answer (code 100). */
export function isBadProof(e: unknown): boolean {
  return e instanceof MetaGraphError && e.code === 100 && Boolean((e as MetaGraphError & { badProof?: boolean }).badProof)
}

/** Meta's "please reduce the amount of data" answer (MAXIMUM at ad level). */
export function isTooMuchData(e: unknown): boolean {
  return e instanceof MetaGraphError && (e.code === 1 || e.code === 100) && Boolean((e as MetaGraphError & { tooMuch?: boolean }).tooMuch)
}

// ── Usage headers ──────────────────────────────────────────────────────────────

/**
 * maxPct: the highest usage % across the headers. regainSeconds: how long Meta
 * says calls are BLOCKED (estimated_time_to_regain_access); 0 when not
 * throttled. resetSeconds: x-ad-account-usage reset_time_duration, the time for
 * the current score to decay to 0. That is above 0 after almost any call, so it
 * only sizes a back-off once a stop is already decided and never causes one.
 */
export type UsageSnapshot = { maxPct: number; regainSeconds: number; resetSeconds: number }

function parseJsonHeader(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : 0
}

/** Highest usage % across the three Meta usage headers, plus the longest wait Meta asks for. */
export function parseUsageHeaders(h: Headers): UsageSnapshot | null {
  let seen = false
  let maxPct = 0
  let regainSeconds = 0
  let resetSeconds = 0
  const buc = parseJsonHeader(h.get('x-business-use-case-usage'))
  if (buc && typeof buc === 'object') {
    for (const list of Object.values(buc as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue
      for (const item of list as Record<string, unknown>[]) {
        seen = true
        maxPct = Math.max(maxPct, num(item.call_count), num(item.total_cputime), num(item.total_time))
        regainSeconds = Math.max(regainSeconds, num(item.estimated_time_to_regain_access) * 60)
      }
    }
  }
  const acct = parseJsonHeader(h.get('x-ad-account-usage'))
  if (acct && typeof acct === 'object') {
    const a = acct as Record<string, unknown>
    seen = true
    maxPct = Math.max(maxPct, num(a.acc_id_util_pct))
    resetSeconds = Math.max(resetSeconds, num(a.reset_time_duration))
  }
  const app = parseJsonHeader(h.get('x-app-usage'))
  if (app && typeof app === 'object') {
    const a = app as Record<string, unknown>
    seen = true
    maxPct = Math.max(maxPct, num(a.call_count), num(a.total_cputime), num(a.total_time))
  }
  return seen ? { maxPct: Math.round(maxPct), regainSeconds: Math.round(regainSeconds), resetSeconds: Math.round(resetSeconds) } : null
}

// ── Route building ─────────────────────────────────────────────────────────────

class RouteRefused extends AdAccountNotAllowedError {
  constructor(ref: string) {
    super(ref, 'route')
  }
}

/** Object ids are digits only, after decoding until stable. */
export function cleanObjectId(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const d = decodeStable(raw.trim())
  return d && /^\d{5,20}$/.test(d) ? d : null
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function insightQuery(p: EdgeParams | undefined, out: Record<string, string>): void {
  const level = p?.level ?? 'account'
  if (!LEVELS.includes(level)) throw new Error('bad level')
  out.level = level
  if (p?.timeRange) {
    const { since, until } = p.timeRange
    if (!DATE_RE.test(since) || !DATE_RE.test(until)) throw new Error('bad range')
    out.time_range = JSON.stringify({ since, until })
  } else {
    const preset = p?.datePreset ?? 'last_30d'
    if (!DATE_PRESETS.includes(preset)) throw new Error('bad preset')
    out.date_preset = preset
  }
  if (level !== 'account') {
    // Built from the fixed constant only, so the route table stays closed.
    out.filtering = JSON.stringify([{ field: `${level}.effective_status`, operator: 'IN', value: INSIGHT_STATUS_FILTER[level] }])
  }
  if (p?.daily) out.time_increment = '1'
  if (p?.hourly) {
    out.breakdowns = HOURLY_BREAKDOWN
    out.fields = HOURLY_INSIGHT_FIELDS
  }
  // Leads land on the day they came in, like the CRM (§3.2).
  out.action_report_time = 'conversion'
  out.use_unified_attribution_setting = 'true'
}

type Built = { path: string; query: Record<string, string>; kind: Route['r'] }

// ── Client ─────────────────────────────────────────────────────────────────────

export type GraphClientOptions = {
  orgId: string
  token: string
  appId: string
  appSecret?: string
  /**
   * app_id from the last debug_token. The proof is sent whenever appSecret is
   * set, unless this is known AND differs from appId (a mismatched pair).
   */
  tokenAppId?: string | null
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv | Env
  onUsage?: (u: UsageSnapshot) => void
  /** Called once per dropped foreign row (deduplicated per client). Defaults to auditRefusal. */
  onRefusal?: (ref: string, where: string) => void | Promise<void>
  /** Does a local Campaign/AdSet/MetaAd with this externalId exist in the bound org on an allowed account? */
  objectAllowed?: (objectId: string) => Promise<boolean>
  /** Writes are off unless META_ADS_WRITES_ENABLED=true. */
  writesEnabled?: boolean
}

type GraphBody = Record<string, unknown> & { error?: { code?: number; error_subcode?: number; message?: string } }

export type BatchResult<T> = { ok: true; body: T } | { ok: false; error: MetaGraphError }

export function createGraphClient(opts: GraphClientOptions) {
  const env = (opts.env ?? process.env) as Env
  const doFetch = opts.fetchImpl ?? fetch
  const base = graphBase(env)
  const refused = new Set<string>()

  const allowedAccounts = (): ReadonlySet<string> => {
    const b = adsBinding(env)
    return b && b.orgId === opts.orgId ? b.accounts : new Set<string>()
  }

  const refuse = async (raw: string, where: string, reason: 'route' | 'not_allowlisted' = 'route'): Promise<never> => {
    const ref = refFor(raw)
    await auditRefusal(opts.orgId, ref, reason, where)
    throw reason === 'route' ? new RouteRefused(ref) : new AdAccountNotAllowedError(ref, reason)
  }

  const noteForeignRow = async (accountId: string, where: string) => {
    const ref = refFor(accountId)
    const key = `${ref}:${where}`
    if (refused.has(key)) return
    refused.add(key)
    if (opts.onRefusal) await opts.onRefusal(ref, where)
    else await auditRefusal(opts.orgId, ref, 'not_allowlisted', where)
  }

  const defaultObjectAllowed = async (objectId: string): Promise<boolean> => {
    const accounts = [...allowedAccounts()]
    if (accounts.length === 0) return false
    const where = { organizationId: opts.orgId, externalId: objectId, adAccountId: { in: accounts } }
    const [c, s, a] = await Promise.all([
      db.campaign.findFirst({ where: { ...where, channel: 'meta' }, select: { id: true } }),
      db.adSet.findFirst({ where, select: { id: true } }),
      db.metaAd.findFirst({ where, select: { id: true } }),
    ])
    return Boolean(c || s || a)
  }
  const objectAllowed = opts.objectAllowed ?? defaultObjectAllowed

  /** Validate a route and build its path and query. Throws (and audits) on anything off-table. */
  async function build(route: Route, where: string): Promise<Built> {
    if (!route || typeof route !== 'object') return refuse('', where)
    if (!isBoundOrg(opts.orgId, env)) {
      const ref = refFor('')
      throw new AdAccountNotAllowedError(ref, adsBinding(env) ? 'unbound_org' : 'not_bound')
    }
    switch (route.r) {
      case 'account': {
        const acct = normalizeAdAccountId(route.account)
        if (!acct || !allowedAccounts().has(acct)) return refuse(route.account, where, acct ? 'not_allowlisted' : 'route')
        const fields = ACCOUNT_FIELDS[route.fields]
        if (!fields) return refuse(route.account, where)
        return { path: acct, query: { fields }, kind: 'account' }
      }
      case 'edge': {
        const acct = normalizeAdAccountId(route.account)
        if (!acct || !allowedAccounts().has(acct)) return refuse(route.account, where, acct ? 'not_allowlisted' : 'route')
        if (!(route.edge in EDGE_FIELDS)) return refuse(route.account, where)
        const query: Record<string, string> = { fields: EDGE_FIELDS[route.edge], limit: '500' }
        try {
          if (route.edge === 'insights') insightQuery(route.params, query)
          else query.effective_status = JSON.stringify(ALL_EFFECTIVE_STATUSES)
        } catch {
          return refuse(route.account, where)
        }
        return { path: `${acct}/${route.edge}`, query, kind: 'edge' }
      }
      case 'object':
      case 'objectInsights': {
        const id = cleanObjectId(route.objectId)
        if (!id) return refuse(String(route.objectId), where)
        if (!(await objectAllowed(id))) return refuse(id, where)
        if (route.r === 'object') {
          const fields = OBJECT_FIELDS[route.fields]
          if (!fields) return refuse(id, where)
          return { path: id, query: { fields }, kind: 'object' }
        }
        const query: Record<string, string> = { fields: INSIGHT_FIELDS, limit: '500' }
        try {
          insightQuery(route.params, query)
        } catch {
          return refuse(id, where)
        }
        return { path: `${id}/insights`, query, kind: 'objectInsights' }
      }
      case 'ownership': {
        const id = cleanObjectId(route.objectId)
        if (!id) return refuse(String(route.objectId), where)
        return { path: id, query: { fields: 'account_id' }, kind: 'ownership' }
      }
      case 'debugToken':
        return { path: 'debug_token', query: {}, kind: 'debugToken' }
      case 'myAccounts':
        return { path: 'me/adaccounts', query: { fields: 'id,account_id', limit: '100' }, kind: 'myAccounts' }
      case 'write': {
        const id = cleanObjectId(route.objectId)
        if (!id) return refuse(String(route.objectId), where)
        if (!opts.writesEnabled) return refuse(id, where)
        if (!(await objectAllowed(id))) return refuse(id, where)
        const allowedKeys = new Set(['status', 'daily_budget', 'lifetime_budget', 'spend_cap'])
        for (const [k, v] of Object.entries(route.form ?? {})) {
          if (!allowedKeys.has(k) || typeof v !== 'string' || !/^[A-Z0-9_]{1,20}$/.test(v)) return refuse(id, where)
        }
        return { path: id, query: {}, kind: 'write' }
      }
      default:
        return refuse('', where)
    }
  }

  // Set once Meta answers "Invalid appsecret_proof": this client's later calls
  // go without it.
  let proofOff = false
  const proof = (): string | null => {
    if (proofOff || !opts.appSecret) return null
    if (opts.tokenAppId && opts.tokenAppId !== opts.appId) return null
    return createHmac('sha256', opts.appSecret).update(opts.token).digest('hex')
  }

  /**
   * Run one request with the proof when there is one. Apps with "Require App
   * Secret" refuse every server call without it (debug_token included), so it
   * goes by default; if Meta calls the proof invalid, retry exactly once
   * without it.
   */
  async function withProof<T>(run: (p: string | null) => Promise<T>): Promise<T> {
    const p = proof()
    try {
      return await run(p)
    } catch (e) {
      if (!p || !isBadProof(e)) throw e
      proofOff = true
      return run(null)
    }
  }

  function urlFor(b: Built, extra: Record<string, string> = {}, p: string | null = null): string {
    const q: Record<string, string> = { ...b.query, ...extra }
    if (p) q.appsecret_proof = p
    const qs = new URLSearchParams(q).toString()
    return `${base}/${b.path}${qs ? `?${qs}` : ''}`
  }

  function relativeUrl(b: Built): string {
    const qs = new URLSearchParams(b.query).toString()
    return `${b.path}${qs ? `?${qs}` : ''}`
  }

  const headers = (): Record<string, string> => ({ Authorization: `Bearer ${opts.token}` })

  function errorFrom(status: number, body: GraphBody | null): MetaGraphError {
    const err = body?.error ?? {}
    const { kind, plain } = classifyGraphError(status, err)
    const e = new MetaGraphError(kind, plain, status, err.code, err.error_subcode)
    if ((err.code === 1 || err.code === 100) && /reduce the amount of data/i.test(err.message ?? '')) {
      ;(e as MetaGraphError & { tooMuch?: boolean }).tooMuch = true
    }
    if (err.code === 100 && /invalid appsecret_proof/i.test(err.message ?? '')) {
      ;(e as MetaGraphError & { badProof?: boolean }).badProof = true
    }
    return e
  }

  async function send(url: string, init: RequestInit): Promise<{ status: number; body: GraphBody | null; usage: UsageSnapshot | null }> {
    let res: Response
    try {
      res = await doFetch(url, init)
    } catch {
      throw new MetaGraphError('transient', PLAIN.transient, 0)
    }
    const usage = parseUsageHeaders(res.headers)
    if (usage && opts.onUsage) opts.onUsage(usage)
    const body = (await res.json().catch(() => null)) as GraphBody | null
    if (!res.ok || !body || body.error) throw errorFrom(res.status, body)
    return { status: res.status, body, usage }
  }

  /** Keep only rows whose account_id is allowed; audit (by hash) the rest. */
  async function filterRows<T>(rows: unknown[], where: string): Promise<T[]> {
    const ok = allowedAccounts()
    const out: T[] = []
    for (const row of rows) {
      const raw = row && typeof row === 'object' ? (row as { account_id?: unknown }).account_id : undefined
      const acct = typeof raw === 'string' || typeof raw === 'number' ? normalizeAdAccountId(String(raw)) : null
      if (acct && ok.has(acct)) out.push(row as T)
      else await noteForeignRow(acct ?? String(raw ?? ''), where)
    }
    return out
  }

  /** Shape the body for routes whose answer must not carry foreign ids. */
  async function shape(b: Built, body: GraphBody, where: string): Promise<unknown> {
    switch (b.kind) {
      case 'account': {
        const acct = normalizeAdAccountId(String(body.account_id ?? body.id ?? ''))
        if (!acct || !allowedAccounts().has(acct)) {
          await noteForeignRow(acct ?? '', where)
          throw new AdAccountNotAllowedError(refFor(acct ?? ''), 'not_allowlisted')
        }
        return body
      }
      case 'object': {
        const kept = await filterRows([body], where)
        if (kept.length === 0) throw new AdAccountNotAllowedError(refFor(String(body.account_id ?? '')), 'not_allowlisted')
        return body
      }
      case 'edge':
      case 'objectInsights': {
        const data = Array.isArray(body.data) ? body.data : []
        return { ...body, data: await filterRows(data, where) }
      }
      case 'ownership': {
        const acct = normalizeAdAccountId(String(body.account_id ?? ''))
        return { allowed: Boolean(acct && allowedAccounts().has(acct)), present: Boolean(acct) }
      }
      case 'myAccounts': {
        const data = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : []
        const ok = allowedAccounts()
        const allowedVisible: string[] = []
        let othersVisible = false
        for (const row of data) {
          const acct = normalizeAdAccountId(String(row.account_id ?? row.id ?? ''))
          if (acct && ok.has(acct)) allowedVisible.push(acct)
          else othersVisible = true
        }
        const paging = body.paging as { next?: string } | undefined
        if (paging?.next && data.length > allowedVisible.length) othersVisible = true
        return { allowedVisible, othersVisible }
      }
      case 'debugToken': {
        const d = (body.data ?? {}) as Record<string, unknown>
        const scopes = Array.isArray(d.scopes) ? (d.scopes as unknown[]).filter((s): s is string => typeof s === 'string') : []
        const granular = Array.isArray(d.granular_scopes) ? (d.granular_scopes as { scope?: string; target_ids?: unknown[] }[]) : []
        const ok = allowedAccounts()
        const type = typeof d.type === 'string' ? d.type : null
        const targets = (scope: string): { all: true } | { unreported: true } | { allowed: string[]; others: number } | null => {
          const g = granular.find((x) => x.scope === scope)
          if (!g) return null
          // A system user gets its accounts from asset assignment in Business
          // Settings, and debug_token usually lists its scopes without
          // target_ids. That means "every account assigned to this system
          // user", not every account: me/adaccounts is the real test.
          if (!Array.isArray(g.target_ids)) return type === 'SYSTEM_USER' ? { unreported: true } : { all: true }
          const allowed: string[] = []
          let others = 0
          for (const t of g.target_ids) {
            const acct = normalizeAdAccountId(String(t))
            if (acct && ok.has(acct)) allowed.push(acct)
            else others++
          }
          return { allowed, others }
        }
        const expires = num(d.expires_at)
        return {
          valid: d.is_valid === true,
          appId: typeof d.app_id === 'string' ? d.app_id : d.app_id != null ? String(d.app_id) : null,
          type,
          expiresAt: expires > 0 ? new Date(expires * 1000) : null,
          scopes,
          adsRead: targets('ads_read'),
          adsManagement: targets('ads_management'),
        }
      }
      default:
        return body
    }
  }

  async function get<T>(route: Route): Promise<{ body: T; usage: UsageSnapshot | null }> {
    const where = `graph.${route?.r ?? 'unknown'}`
    const b = await build(route, where)
    if (b.kind === 'write') return refuse('', where)
    if (b.kind === 'debugToken') {
      // debug_token wants the token as input_token. It goes in a POST body
      // (a one-item batch), so it never appears in a request URL. The proof
      // rides in the same body.
      const { res, item } = await withProof(async (p) => {
        const form: Record<string, string> = {
          batch: JSON.stringify([{ method: 'GET', relative_url: `debug_token?${new URLSearchParams({ input_token: opts.token })}` }]),
          include_headers: 'false',
        }
        if (p) form.appsecret_proof = p
        const res = await send(base, {
          method: 'POST',
          headers: { ...headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(form),
        })
        const first = Array.isArray(res.body) ? (res.body as unknown[])[0] : (res.body as unknown as unknown[])?.[0]
        const parsed = parseBatchItem(first)
        if (!parsed.ok) throw parsed.error
        return { res, item: parsed.body }
      })
      return { body: (await shape(b, item, where)) as T, usage: res.usage }
    }
    const res = await withProof((p) => send(urlFor(b, {}, p), { method: 'GET', headers: headers() }))
    return { body: (await shape(b, res.body!, where)) as T, usage: res.usage }
  }

  /** Edge or objectInsights rows across pages (cursor paging, never inside a batch). */
  async function getAllPages<T>(route: Route, maxPages = 20): Promise<{ data: T[]; truncated: boolean }> {
    const where = `graph.${route?.r ?? 'unknown'}.pages`
    const b = await build(route, where)
    if (b.kind !== 'edge' && b.kind !== 'objectInsights') return refuse('', where)
    const out: T[] = []
    let after: string | null = null
    for (let page = 0; page < maxPages; page++) {
      const res = await withProof((p) => send(urlFor(b, after ? { after } : {}, p), { method: 'GET', headers: headers() }))
      const data = Array.isArray(res.body!.data) ? (res.body!.data as unknown[]) : []
      out.push(...(await filterRows<T>(data, where)))
      const paging = res.body!.paging as { next?: string; cursors?: { after?: string } } | undefined
      const cursor = paging?.cursors?.after
      if (!paging?.next || !cursor) return { data: out, truncated: false }
      if (typeof cursor !== 'string' || cursor.length > 1024 || !/^[A-Za-z0-9_=\-.%]+$/.test(cursor)) {
        return { data: out, truncated: true }
      }
      after = cursor
    }
    return { data: out, truncated: true }
  }

  function parseBatchItem(item: unknown): { ok: true; body: GraphBody } | { ok: false; error: MetaGraphError } {
    if (!item || typeof item !== 'object') return { ok: false, error: new MetaGraphError('transient', PLAIN.transient, 0) }
    const it = item as { code?: number; body?: string }
    let body: GraphBody | null = null
    try {
      body = it.body ? (JSON.parse(it.body) as GraphBody) : null
    } catch {
      body = null
    }
    const status = typeof it.code === 'number' ? it.code : 0
    if (status < 200 || status >= 300 || !body || body.error) return { ok: false, error: errorFrom(status, body) }
    return { ok: true, body }
  }

  /** Up to 50 single-object reads (or account-level insight rows) in one POST. */
  async function batch<T>(routes: Route[]): Promise<BatchResult<T>[]> {
    const where = 'graph.batch'
    if (!Array.isArray(routes) || routes.length === 0) return []
    if (routes.length > 50) return refuse('', where)
    const built: Built[] = []
    for (const r of routes) {
      const b = await build(r, where)
      const singleRow =
        b.kind === 'account' || b.kind === 'object' || b.kind === 'ownership' ||
        (b.kind === 'edge' && r.r === 'edge' && r.edge === 'insights' && (r.params?.level ?? 'account') === 'account' && !r.params?.daily && !r.params?.hourly)
      if (!singleRow) return refuse('', where)
      built.push(b)
    }
    const res = await withProof((p) => {
      const form: Record<string, string> = {
        batch: JSON.stringify(built.map((b) => ({ method: 'GET', relative_url: relativeUrl(b) }))),
        include_headers: 'false',
      }
      if (p) form.appsecret_proof = p
      return send(base, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form),
      })
    })
    const items = Array.isArray(res.body) ? (res.body as unknown[]) : Object.values(res.body ?? {})
    const out: BatchResult<T>[] = []
    for (let i = 0; i < built.length; i++) {
      const parsed = parseBatchItem(items[i])
      if (!parsed.ok) {
        out.push(parsed)
        continue
      }
      try {
        out.push({ ok: true, body: (await shape(built[i], parsed.body, where)) as T })
      } catch (e) {
        out.push({ ok: false, error: e instanceof MetaGraphError ? e : new MetaGraphError('other', PLAIN.other, 0) })
      }
    }
    return out
  }

  async function post<T>(route: Extract<Route, { r: 'write' }>): Promise<T> {
    const where = 'graph.write'
    const b = await build(route, where)
    if (b.kind !== 'write') return refuse('', where)
    const res = await withProof((p) => {
      const form: Record<string, string> = { ...route.form }
      if (p) form.appsecret_proof = p
      return send(`${base}/${b.path}`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form),
      })
    })
    return res.body as T
  }

  return { get, getAllPages, batch, post }
}

export type GraphClient = ReturnType<typeof createGraphClient>
