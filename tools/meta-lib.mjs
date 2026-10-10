/**
 * Helpers behind tools/meta.mjs, split out so they can be unit-tested with a
 * mocked fetch. Every helper here is READ-ONLY (HTTP GET) except
 * subscribePage(), which the CLI only calls from `subscribe --yes`.
 *
 * Tokens are never printed: summaries carry token TYPE / app / scopes / expiry,
 * never the token string.
 */
import { createHmac } from 'node:crypto'

/** @typedef {{ pageId?: string, pageToken?: string, systemUserToken?: string }} PageTokenInput */

export const GRAPH = 'https://graph.facebook.com/v21.0'
export const SCS_ENGLISH_PAGE_ID = '1333173556539688'

/**
 * GET a Graph path. Throws with Graph's own error message on failure.
 * @param {string} path
 * @param {Record<string, string>} params
 * @param {string | undefined} token
 * @param {typeof fetch} [fetchImpl]
 */
export async function graphGet(path, params, token, fetchImpl = fetch) {
  const qs = new URLSearchParams({ ...params, access_token: token ?? '' })
  const res = await fetchImpl(`${GRAPH}${path}?${qs}`)
  const body = await res.json()
  if (!res.ok || body.error) {
    const err = new Error(body.error?.message ?? res.statusText ?? 'Graph request failed')
    err.code = body.error?.code
    throw err
  }
  return body
}

/**
 * A Page access token for `pageId`. Order:
 *  1. META_PAGE_ACCESS_TOKEN when set (used as-is);
 *  2. exchange the System User token: GET /{page}?fields=access_token;
 *  3. fall back to GET /me/accounts and pick the page.
 * All reads. Returns { token, via } — `via` names the route, never the token.
 */
/**
 * @param {PageTokenInput} input
 * @param {typeof fetch} [fetchImpl]
 */
export async function resolvePageToken({ pageId, pageToken, systemUserToken }, fetchImpl = fetch) {
  if (pageToken) return { token: pageToken, via: 'META_PAGE_ACCESS_TOKEN' }
  if (!systemUserToken) throw new Error('Needs META_PAGE_ACCESS_TOKEN or META_SYSTEM_USER_TOKEN.')
  if (!pageId) throw new Error('Needs a page id (META_PAGE_ID or --page).')
  try {
    const page = await graphGet(`/${pageId}`, { fields: 'id,name,access_token' }, systemUserToken, fetchImpl)
    if (page.access_token) return { token: page.access_token, via: `/${pageId}?fields=access_token`, pageName: page.name ?? null }
  } catch {
    // fall through to /me/accounts
  }
  let next = null
  let params = { fields: 'id,name,access_token', limit: '100' }
  for (let i = 0; i < 10; i++) {
    const res = next
      ? await (async () => { const r = await fetchImpl(next); const b = await r.json(); if (!r.ok || b.error) throw new Error(b.error?.message ?? 'Graph request failed'); return b })()
      : await graphGet('/me/accounts', params, systemUserToken, fetchImpl)
    const hit = (res.data ?? []).find((p) => String(p.id) === String(pageId))
    if (hit?.access_token) return { token: hit.access_token, via: '/me/accounts', pageName: hit.name ?? null }
    next = res.paging?.next ?? null
    if (!next) break
  }
  throw new Error(`System User token cannot see page ${pageId} (not in /${pageId}?fields=access_token or /me/accounts).`)
}

/** Plain-words summary of GET /{page}/subscribed_apps. */
export function summarizeSubscribedApps(body, appId) {
  const apps = (body?.data ?? []).map((a) => ({
    id: String(a.id),
    name: a.name ?? null,
    fields: Array.isArray(a.subscribed_fields) ? a.subscribed_fields : [],
  }))
  const ours = appId ? apps.find((a) => a.id === String(appId)) ?? null : null
  return {
    apps,
    ourAppSubscribed: Boolean(ours),
    ourAppHasLeadgen: Boolean(ours?.fields.includes('leadgen')),
    otherApps: apps.filter((a) => a.id !== String(appId)),
  }
}

/**
 * 'act_123…' or '123…' (5 to 20 digits, URL-decoded until stable) → 'act_123…';
 * anything else → null. Same rule as src/lib/meta/ads/allowlist.ts.
 * @param {unknown} raw
 */
export function normalizeAdAccountId(raw) {
  if (typeof raw !== 'string') return null
  let cur = raw.trim()
  for (let i = 0; i < 5; i++) {
    let next
    try { next = decodeURIComponent(cur) } catch { return null }
    if (next === cur) break
    cur = next
    if (i === 4) return null
  }
  const m = /^(?:act_)?(\d{5,20})$/.exec(cur.trim())
  return m ? `act_${m[1]}` : null
}

/**
 * META_ALLOWED_AD_ACCOUNTS as a Set, or null when unset, empty or any entry is
 * malformed (one bad entry fails the whole list closed, like the app).
 * @param {Record<string, string | undefined>} [env]
 */
export function allowedAdAccounts(env = process.env) {
  const parts = (env.META_ALLOWED_AD_ACCOUNTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const out = new Set()
  for (const p of parts) {
    const n = normalizeAdAccountId(p)
    if (!n) return null
    out.add(n)
  }
  return out
}

/**
 * The ad account the CLI may read: META_AD_ACCOUNT_ID, only when it is in
 * META_ALLOWED_AD_ACCOUNTS. Never echoes a refused id.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ ok: true, act: string } | { ok: false, error: string }}
 */
export function cliAdAccount(env = process.env) {
  const act = normalizeAdAccountId(env.META_AD_ACCOUNT_ID ?? '')
  if (!act) return { ok: false, error: 'META_AD_ACCOUNT_ID must be act_ followed by digits.' }
  const allowed = allowedAdAccounts(env)
  if (!allowed) return { ok: false, error: 'META_ALLOWED_AD_ACCOUNTS must be set (and valid) before reading any ad account.' }
  if (!allowed.has(act)) return { ok: false, error: "META_AD_ACCOUNT_ID isn't in META_ALLOWED_AD_ACCOUNTS. Refusing to read it." }
  return { ok: true, act }
}

/**
 * Printable targets for one granular scope. Ad scopes show approved account
 * ids only, plus a COUNT of any others (never their ids). Other scopes (pages)
 * print as they are.
 * @param {{ scope: string, targets: string[] }} g
 * @param {Set<string> | null} allowed
 */
export function describeGranularTargets(g, allowed) {
  if (!g.targets.length) return 'all'
  if (!g.scope.startsWith('ads_')) return g.targets.join(', ')
  const shown = []
  let others = 0
  for (const t of g.targets) {
    const n = normalizeAdAccountId(t)
    if (n && allowed?.has(n)) shown.push(n)
    else others++
  }
  return `${shown.join(', ') || 'no approved account'}${others ? ` plus ${others} other account(s)` : ''}`
}

/** Plain-words summary of GET /debug_token (no token string in the output). */
export function summarizeDebugToken(body) {
  const d = body?.data ?? {}
  const ts = (n) => (typeof n === 'number' && n > 0 ? new Date(n * 1000).toISOString() : n === 0 ? 'never' : null)
  return {
    isValid: Boolean(d.is_valid),
    type: d.type ?? null,
    appId: d.app_id ? String(d.app_id) : null,
    application: d.application ?? null,
    userId: d.user_id ? String(d.user_id) : null,
    expiresAt: ts(d.expires_at),
    dataAccessExpiresAt: ts(d.data_access_expires_at),
    scopes: Array.isArray(d.scopes) ? d.scopes : [],
    hasLeadsRetrieval: Array.isArray(d.scopes) && d.scopes.includes('leads_retrieval'),
    granular: (d.granular_scopes ?? []).map((g) => ({ scope: g.scope, targets: (g.target_ids ?? []).map(String) })),
    error: d.error?.message ?? null,
  }
}

/**
 * GET /debug_token. Inspects `inputToken` using itself (or an app token) as the access token.
 * @param {{ inputToken?: string, accessToken?: string }} input
 * @param {typeof fetch} [fetchImpl]
 */
export async function checkToken({ inputToken, accessToken }, fetchImpl = fetch) {
  if (!inputToken) throw new Error('No token to inspect.')
  const body = await graphGet('/debug_token', { input_token: inputToken }, accessToken || inputToken, fetchImpl)
  return summarizeDebugToken(body)
}

/**
 * GET /{page}/subscribed_apps with a Page token resolved read-only.
 * @param {PageTokenInput & { appId?: string }} input
 * @param {typeof fetch} [fetchImpl]
 */
export async function checkSubscription({ pageId, appId, pageToken, systemUserToken }, fetchImpl = fetch) {
  const page = await resolvePageToken({ pageId, pageToken, systemUserToken }, fetchImpl)
  const body = await graphGet(`/${pageId}/subscribed_apps`, {}, page.token, fetchImpl)
  return { pageId, tokenVia: page.via, ...summarizeSubscribedApps(body, appId) }
}

/**
 * POST /{page}/subscribed_apps (leadgen). The ONLY write in this file. The CLI
 * calls it only from `subscribe --yes`.
 * @param {PageTokenInput} input
 * @param {typeof fetch} [fetchImpl]
 */
export async function subscribePage({ pageId, pageToken, systemUserToken }, fetchImpl = fetch) {
  const page = await resolvePageToken({ pageId, pageToken, systemUserToken }, fetchImpl)
  const res = await fetchImpl(`${GRAPH}/${pageId}/subscribed_apps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ subscribed_fields: 'leadgen', access_token: page.token }),
  })
  const body = await res.json()
  if (!res.ok || body.error) throw new Error(body.error?.message ?? res.statusText)
  return { success: Boolean(body.success), tokenVia: page.via }
}

/** X-Hub-Signature-256 header for a raw body. */
export function signBody(raw, secret) {
  return 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')
}

/**
 * A leadgen webhook body. With `fixture`, the change also carries a Graph-shaped
 * `fixture_lead` that a PREVIEW deployment in fixture mode reads instead of
 * calling Meta (production ignores it and reads Graph).
 * @param {{ leadgenId: string, pageId?: string, formId?: string, adId?: string, adsetId?: string, fixture?: Record<string, unknown> }} input
 */
export function leadgenWebhookBody({ leadgenId, pageId, formId, adId, adsetId, fixture }) {
  const value = { leadgen_id: leadgenId }
  if (pageId) value.page_id = pageId
  if (formId) value.form_id = formId
  if (adId) value.ad_id = adId
  if (adsetId) value.adgroup_id = adsetId
  if (fixture) value.fixture_lead = { id: leadgenId, ...fixture }
  return JSON.stringify({
    object: 'page',
    entry: [{ id: pageId ?? undefined, time: Math.floor(Date.now() / 1000), changes: [{ field: 'leadgen', value }] }],
  })
}
