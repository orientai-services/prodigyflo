#!/usr/bin/env node
/**
 * The "fb" command-line tool for ProdigyFlo's Meta connection.
 *
 *   node tools/meta.mjs status        env/credential + webhook readiness
 *   node tools/meta.mjs verify        prove the token works against Graph
 *   node tools/meta.mjs subscribe     subscribe the Page to leadgen webhooks
 *   node tools/meta.mjs test-lead     fire a signed synthetic lead at the app
 *   node tools/meta.mjs campaigns     list campaigns (Graph, needs credentials)
 *   node tools/meta.mjs spend         last-7-day spend (Graph, needs credentials)
 *
 * `test-lead` works with or without credentials — it signs the payload the same
 * way the app expects, so it exercises webhook → intake → CRM end to end.
 * Target another instance with --url https://prodigyflo.ai
 */
import 'dotenv/config'
import { createHash, createHmac } from 'node:crypto'

const GRAPH = 'https://graph.facebook.com/v21.0'
const cmd = process.argv[2]
const urlFlag = process.argv.indexOf('--url')
const BASE = urlFlag > -1 ? process.argv[urlFlag + 1] : (process.env.APP_URL || 'http://localhost:3300')

const creds = {
  appId: process.env.META_APP_ID,
  appSecret: process.env.META_APP_SECRET,
  pageToken: process.env.META_PAGE_ACCESS_TOKEN,
  adAccountId: process.env.META_AD_ACCOUNT_ID,
  pageId: process.env.META_PAGE_ID,
}
const configured = Boolean(creds.appId && creds.appSecret && creds.pageToken)

// Must match src/lib/meta/provider.ts metaVerifyToken()
const verifyToken = createHash('sha256')
  .update(`${process.env.AUTH_SECRET ?? 'prodigyflo'}:meta-webhook-verify`)
  .digest('hex')
  .slice(0, 32)

async function graph(path, params = {}, init) {
  const qs = new URLSearchParams({ ...params, access_token: creds.pageToken ?? '' })
  const res = await fetch(`${GRAPH}${path}?${qs}`, init)
  const body = await res.json()
  if (!res.ok || body.error) throw new Error(body.error?.message ?? res.statusText)
  return body
}

const mark = (ok) => (ok ? '✓' : '✗')

switch (cmd) {
  case 'status': {
    console.log(`Meta connection status (mode: ${configured ? 'GRAPH — live' : 'MOCK'})`)
    console.log(`  ${mark(!!creds.appId)} META_APP_ID`)
    console.log(`  ${mark(!!creds.appSecret)} META_APP_SECRET`)
    console.log(`  ${mark(!!creds.pageToken)} META_PAGE_ACCESS_TOKEN`)
    console.log(`  ${mark(!!creds.adAccountId)} META_AD_ACCOUNT_ID (campaigns/spend)`)
    console.log(`  ${mark(!!creds.pageId)} META_PAGE_ID (subscribe)`)
    console.log(`\nWebhook callback:  ${BASE}/api/meta/leads`)
    console.log(`Verify token:      ${verifyToken}`)
    break
  }
  case 'verify': {
    if (!configured) { console.error('Set META_APP_ID / META_APP_SECRET / META_PAGE_ACCESS_TOKEN first.'); process.exit(1) }
    const me = await graph('/me', { fields: 'id,name' })
    console.log(`✓ token valid — acting as ${me.name} (${me.id})`)
    break
  }
  case 'subscribe': {
    if (!configured || !creds.pageId) { console.error('Needs credentials plus META_PAGE_ID.'); process.exit(1) }
    const res = await graph(`/${creds.pageId}/subscribed_apps`, {}, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ subscribed_fields: 'leadgen', access_token: creds.pageToken }),
    })
    console.log(res.success ? '✓ page subscribed to leadgen webhooks' : JSON.stringify(res))
    console.log(`Make sure the app-level webhook points at ${BASE}/api/meta/leads with verify token ${verifyToken}`)
    break
  }
  case 'test-lead': {
    const body = JSON.stringify({
      object: 'page',
      entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: `cli_${Date.now().toString(36)}` } }] }],
    })
    const secret = configured ? creds.appSecret : verifyToken
    const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
    const res = await fetch(`${BASE}/api/meta/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
      body,
    })
    console.log(`${res.status} ${JSON.stringify(await res.json())}`)
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
    console.log('usage: node tools/meta.mjs <status|verify|subscribe|test-lead|campaigns|spend> [--url https://prodigyflo.ai]')
}
