#!/usr/bin/env node
/**
 * The "fb" command-line tool for ProdigyFlo's Meta connection.
 *
 *   node tools/meta.mjs status              env/credential + webhook readiness
 *   node tools/meta.mjs verify              prove the token works against Graph
 *   node tools/meta.mjs check-token         READ-ONLY: /debug_token (type, app, scopes, expiry)
 *   node tools/meta.mjs check-subscription  READ-ONLY: /{page}/subscribed_apps (is our app on leadgen?)
 *   node tools/meta.mjs subscribe --yes     subscribe the Page to leadgen webhooks (WRITES to Meta)
 *   node tools/meta.mjs test-lead           fire a signed synthetic lead at the app
 *   node tools/meta.mjs campaigns           list campaigns (Graph, needs credentials)
 *   node tools/meta.mjs spend               last-7-day spend (Graph, needs credentials)
 *
 * Tokens: META_PAGE_ACCESS_TOKEN is used when set; otherwise the System User
 * token (META_SYSTEM_USER_TOKEN) is exchanged for a Page token with read-only
 * GETs (/{page}?fields=access_token, then /me/accounts). Tokens are never printed.
 *
 * Flags: --url <base> (test-lead target), --page <id> (default META_PAGE_ID, else
 * the SCS English page), --token system|page (check-token), --fixture (test-lead:
 * include a mocked Graph lead for a preview in META_FIXTURE_LEADS mode),
 * --state <XX> / --name <text> (test-lead fixture fields).
 *
 * `test-lead` works with or without credentials — it signs the payload the same
 * way the app expects, so it exercises webhook → intake → CRM end to end.
 */
import 'dotenv/config'
import { createHash } from 'node:crypto'
import {
  SCS_ENGLISH_PAGE_ID, checkSubscription, checkToken, graphGet, leadgenWebhookBody,
  resolvePageToken, signBody, subscribePage,
} from './meta-lib.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0]
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i > -1 ? argv[i + 1] : undefined }
const has = (name) => argv.includes(`--${name}`)
const BASE = flag('url') || process.env.APP_URL || 'http://localhost:3300'

const creds = {
  appId: process.env.META_APP_ID,
  appSecret: process.env.META_APP_SECRET,
  pageToken: process.env.META_PAGE_ACCESS_TOKEN,
  systemUserToken: process.env.META_SYSTEM_USER_TOKEN,
  adAccountId: process.env.META_AD_ACCOUNT_ID,
  pageId: flag('page') || process.env.META_PAGE_ID || SCS_ENGLISH_PAGE_ID,
}
const leadToken = creds.pageToken || creds.systemUserToken
const configured = Boolean(creds.appId && creds.appSecret && leadToken)

// Must match src/lib/meta/provider.ts metaVerifyToken()
const verifyToken = createHash('sha256')
  .update(`${process.env.AUTH_SECRET ?? 'prodigyflo'}:meta-webhook-verify`)
  .digest('hex')
  .slice(0, 32)

async function graph(path, params = {}) {
  return graphGet(path, params, creds.systemUserToken || creds.pageToken)
}

const mark = (ok) => (ok ? '✓' : '✗')

switch (cmd) {
  case 'status': {
    console.log(`Meta connection status (mode: ${configured ? 'GRAPH — live' : 'MOCK'})`)
    console.log(`  ${mark(!!creds.appId)} META_APP_ID`)
    console.log(`  ${mark(!!creds.appSecret)} META_APP_SECRET`)
    console.log(`  ${mark(!!creds.pageToken)} META_PAGE_ACCESS_TOKEN`)
    console.log(`  ${mark(!!creds.systemUserToken)} META_SYSTEM_USER_TOKEN (Page token exchanged from it when no Page token)`)
    console.log(`  ${mark(!!creds.adAccountId)} META_AD_ACCOUNT_ID (campaigns/spend)`)
    console.log(`  ${mark(!!process.env.META_PAGE_ID)} META_PAGE_ID (subscribe; default ${SCS_ENGLISH_PAGE_ID})`)
    console.log(`\nWebhook callback:  ${BASE}/api/meta/leads`)
    console.log(`Verify token:      ${verifyToken}`)
    break
  }
  case 'verify': {
    if (!configured) { console.error('Set META_APP_ID / META_APP_SECRET and META_PAGE_ACCESS_TOKEN or META_SYSTEM_USER_TOKEN first.'); process.exit(1) }
    const me = await graph('/me', { fields: 'id,name' })
    console.log(`✓ token valid — acting as ${me.name} (${me.id})`)
    break
  }
  case 'check-token': {
    // READ-ONLY. Which token: --token system|page (default: system when set).
    const which = flag('token') || (creds.systemUserToken ? 'system' : 'page')
    let inputToken = which === 'system' ? creds.systemUserToken : creds.pageToken
    if (which === 'page' && !inputToken && creds.systemUserToken) {
      inputToken = (await resolvePageToken({ pageId: creds.pageId, systemUserToken: creds.systemUserToken })).token
    }
    if (!inputToken) { console.error(`No ${which} token in env.`); process.exit(1) }
    const appToken = creds.appId && creds.appSecret ? `${creds.appId}|${creds.appSecret}` : undefined
    const t = await checkToken({ inputToken, accessToken: appToken })
    console.log(`Token (${which}) — ${t.isValid ? '✓ valid' : '✗ NOT valid'}${t.error ? ` (${t.error})` : ''}`)
    console.log(`  type:        ${t.type ?? '?'}`)
    console.log(`  app:         ${t.application ?? '?'} (${t.appId ?? '?'})${creds.appId && t.appId && t.appId !== String(creds.appId) ? '  ⚠ not META_APP_ID' : ''}`)
    console.log(`  expires:     ${t.expiresAt ?? '?'}`)
    console.log(`  data access: ${t.dataAccessExpiresAt ?? '?'}`)
    console.log(`  scopes:      ${t.scopes.join(', ') || '(none)'}`)
    console.log(`  ${mark(t.hasLeadsRetrieval)} leads_retrieval`)
    for (const g of t.granular) console.log(`  granular ${g.scope}: ${g.targets.join(', ') || 'all'}`)
    break
  }
  case 'check-subscription': {
    // READ-ONLY: resolves a Page token with GETs, then GET /{page}/subscribed_apps.
    const s = await checkSubscription({ pageId: creds.pageId, appId: creds.appId, pageToken: creds.pageToken, systemUserToken: creds.systemUserToken })
    console.log(`Page ${s.pageId} subscribed apps (Page token via ${s.tokenVia}):`)
    if (!s.apps.length) console.log('  (none — no app receives this page\'s leadgen webhooks)')
    for (const a of s.apps) console.log(`  ${a.id === String(creds.appId) ? '→' : ' '} ${a.name ?? '?'} (${a.id}): ${a.fields.join(', ') || '(no fields)'}`)
    console.log(`  ${mark(s.ourAppSubscribed)} META_APP_ID ${creds.appId ?? '(unset)'} subscribed`)
    console.log(`  ${mark(s.ourAppHasLeadgen)} … with the leadgen field`)
    if (s.otherApps.length) console.log(`  ⚠ other apps also subscribed: ${s.otherApps.map((a) => `${a.name ?? '?'} (${a.id})`).join(', ')}`)
    break
  }
  case 'subscribe': {
    // The one WRITE. Requires --yes so it is never run by accident.
    if (!creds.pageId || !leadToken) { console.error('Needs META_PAGE_ACCESS_TOKEN or META_SYSTEM_USER_TOKEN, plus a page id.'); process.exit(1) }
    if (!has('yes')) {
      console.log(`Dry run: would POST /${creds.pageId}/subscribed_apps subscribed_fields=leadgen (Page token from ${creds.pageToken ? 'META_PAGE_ACCESS_TOKEN' : 'the System User token'}).`)
      console.log('Re-run with --yes to actually subscribe.')
      break
    }
    const res = await subscribePage({ pageId: creds.pageId, pageToken: creds.pageToken, systemUserToken: creds.systemUserToken })
    console.log(res.success ? `✓ page subscribed to leadgen webhooks (Page token via ${res.tokenVia})` : JSON.stringify(res))
    console.log(`Make sure the app-level webhook points at ${BASE}/api/meta/leads with verify token ${verifyToken}`)
    break
  }
  case 'test-lead': {
    const leadgenId = flag('leadgen') || `cli_${Date.now().toString(36)}`
    const fixture = has('fixture')
      ? {
          created_time: new Date().toISOString(),
          field_data: [
            { name: 'full_name', values: [flag('name') || 'STAGING TEST Lead'] },
            { name: 'email', values: [`staging-test-${leadgenId}@example.test`] },
            { name: 'phone_number', values: ['+17025550142'] },
            { name: 'state', values: [flag('state') || 'NV'] },
            { name: 'zip_code', values: [flag('zip') || '89117'] },
          ],
          ad_id: 'test_ad_120200000000001',
          ad_name: 'STAGING TEST Ad — Solar Relief Video',
          adset_id: 'test_adset_120200000000002',
          adset_name: 'STAGING TEST Ad Set — Las Vegas 35+',
          campaign_id: 'test_campaign_120200000000003',
          campaign_name: 'STAGING TEST Campaign — Q4 Solar Contract Review',
          form_id: 'test_form_120200000000004',
          platform: flag('platform') || 'ig',
          is_organic: false,
        }
      : undefined
    const body = leadgenWebhookBody({
      leadgenId,
      pageId: flag('page') || (fixture ? 'test_page_staging' : undefined),
      formId: fixture?.form_id,
      adId: fixture?.ad_id,
      adsetId: fixture?.adset_id,
      fixture,
    })
    const secret = creds.appSecret || verifyToken
    const res = await fetch(`${BASE}/api/meta/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signBody(body, secret) },
      body,
    })
    console.log(`${res.status} ${await res.text()}`)
    break
  }
  case 'campaigns': {
    if (!configured || !creds.adAccountId) { console.error('Needs credentials plus META_AD_ACCOUNT_ID.'); process.exit(1) }
    const act = creds.adAccountId.startsWith('act_') ? creds.adAccountId : `act_${creds.adAccountId}`
    const res = await graph(`/${act}/campaigns`, { fields: 'id,name,objective,status,daily_budget', limit: '50' })
    for (const c of res.data) {
      console.log(`${c.status.padEnd(8)} ${c.name}  (${c.objective ?? '-'}, $${c.daily_budget ? Number(c.daily_budget) / 100 : '?'}/day)  ${c.id}`)
    }
    break
  }
  case 'spend': {
    if (!configured || !creds.adAccountId) { console.error('Needs credentials plus META_AD_ACCOUNT_ID.'); process.exit(1) }
    const act = creds.adAccountId.startsWith('act_') ? creds.adAccountId : `act_${creds.adAccountId}`
    const res = await graph(`/${act}/insights`, { date_preset: 'last_7d', time_increment: '1', fields: 'spend,impressions,clicks' })
    for (const r of res.data) console.log(`${r.date_start}  $${r.spend ?? 0}  ${r.impressions ?? 0} imp  ${r.clicks ?? 0} clicks`)
    break
  }
  default:
    console.log('usage: node tools/meta.mjs <status|verify|check-token|check-subscription|subscribe --yes|test-lead|campaigns|spend> [--url https://prodigyflo.ai] [--page <id>]')
}
