import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  checkSubscription, checkToken, leadgenWebhookBody, resolvePageToken, signBody, summarizeSubscribedApps,
} from '../tools/meta-lib.mjs'

type Call = { url: URL; method: string }

/** A fake Graph: routes by path, records every call and its HTTP method. */
function fakeGraph(routes: Record<string, (url: URL) => unknown>) {
  const calls: Call[] = []
  const impl = async (input: string, init?: { method?: string }) => {
    const url = new URL(input)
    calls.push({ url, method: init?.method ?? 'GET' })
    const path = url.pathname.replace('/v21.0', '')
    const handler = routes[path]
    const body = handler ? handler(url) : { error: { message: `no route ${path}`, code: 803 } }
    const error = (body as { error?: unknown }).error
    return { ok: !error, statusText: error ? 'Bad Request' : 'OK', json: async () => body } as unknown as Response
  }
  return { impl: impl as unknown as typeof fetch, calls }
}

const PAGE = '1333173556539688'
const APP = '1072957135381673'

describe('tools/meta.mjs — Page token from the System User token (read-only)', () => {
  it('uses META_PAGE_ACCESS_TOKEN as-is when set (no Graph call)', async () => {
    const g = fakeGraph({})
    const r = await resolvePageToken({ pageId: PAGE, pageToken: 'PAGE_TOKEN', systemUserToken: 'SU' }, g.impl)
    expect(r).toEqual({ token: 'PAGE_TOKEN', via: 'META_PAGE_ACCESS_TOKEN' })
    expect(g.calls).toHaveLength(0)
  })

  it('exchanges via GET /{page}?fields=access_token', async () => {
    const g = fakeGraph({ [`/${PAGE}`]: (u) => ({ id: PAGE, name: 'SCS', access_token: u.searchParams.get('access_token') === 'SU' ? 'PAGE_FROM_SU' : null }) })
    const r = await resolvePageToken({ pageId: PAGE, systemUserToken: 'SU' }, g.impl)
    expect(r.token).toBe('PAGE_FROM_SU')
    expect(r.via).toContain('fields=access_token')
    expect(g.calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('falls back to GET /me/accounts when the page read fails', async () => {
    const g = fakeGraph({
      '/me/accounts': () => ({ data: [{ id: '999', access_token: 'NOPE' }, { id: PAGE, name: 'SCS', access_token: 'PAGE_FROM_ACCOUNTS' }] }),
    })
    const r = await resolvePageToken({ pageId: PAGE, systemUserToken: 'SU' }, g.impl)
    expect(r).toMatchObject({ token: 'PAGE_FROM_ACCOUNTS', via: '/me/accounts' })
    expect(g.calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('explains when the System User cannot see the page', async () => {
    const g = fakeGraph({ '/me/accounts': () => ({ data: [] }) })
    await expect(resolvePageToken({ pageId: PAGE, systemUserToken: 'SU' }, g.impl)).rejects.toThrow(/cannot see page/)
  })
})

describe('check-subscription (read-only)', () => {
  it('reports our app + leadgen and flags any other subscribed app', async () => {
    const g = fakeGraph({
      [`/${PAGE}`]: () => ({ id: PAGE, access_token: 'PT' }),
      [`/${PAGE}/subscribed_apps`]: (u) => {
        expect(u.searchParams.get('access_token')).toBe('PT')
        return { data: [
          { id: APP, name: 'SCS Integration', subscribed_fields: ['leadgen'] },
          { id: '555', name: 'SunOff Leads', subscribed_fields: ['leadgen', 'feed'] },
        ] }
      },
    })
    const s = await checkSubscription({ pageId: PAGE, appId: APP, systemUserToken: 'SU' }, g.impl)
    expect(s.ourAppSubscribed).toBe(true)
    expect(s.ourAppHasLeadgen).toBe(true)
    expect(s.otherApps.map((a: { name: string }) => a.name)).toEqual(['SunOff Leads'])
    expect(g.calls.every((c) => c.method === 'GET')).toBe(true)
    expect(JSON.stringify(s)).not.toContain('PT')
  })

  it('says plainly when our app is missing or lacks leadgen', () => {
    expect(summarizeSubscribedApps({ data: [] }, APP)).toMatchObject({ ourAppSubscribed: false, ourAppHasLeadgen: false })
    expect(summarizeSubscribedApps({ data: [{ id: APP, subscribed_fields: ['feed'] }] }, APP))
      .toMatchObject({ ourAppSubscribed: true, ourAppHasLeadgen: false })
  })
})

describe('check-token (read-only)', () => {
  it('summarizes /debug_token without echoing the token', async () => {
    const g = fakeGraph({
      '/debug_token': (u) => {
        expect(u.searchParams.get('input_token')).toBe('SECRET_SU_TOKEN')
        expect(u.searchParams.get('access_token')).toBe(`${APP}|appsecret`)
        return { data: {
          app_id: APP, type: 'SYSTEM_USER', application: 'SCS Integration', is_valid: true,
          expires_at: 0, data_access_expires_at: 1800000000,
          scopes: ['leads_retrieval', 'pages_show_list', 'ads_read'],
          granular_scopes: [{ scope: 'leads_retrieval', target_ids: [PAGE] }],
        } }
      },
    })
    const t = await checkToken({ inputToken: 'SECRET_SU_TOKEN', accessToken: `${APP}|appsecret` }, g.impl)
    expect(t).toMatchObject({ isValid: true, type: 'SYSTEM_USER', appId: APP, expiresAt: 'never', hasLeadsRetrieval: true })
    expect(t.granular[0]).toEqual({ scope: 'leads_retrieval', targets: [PAGE] })
    expect(JSON.stringify(t)).not.toContain('SECRET_SU_TOKEN')
    expect(g.calls.every((c) => c.method === 'GET')).toBe(true)
  })
})

describe('signed sample webhook payloads', () => {
  it('signs exactly like Meta (HMAC-SHA256 of the raw body)', () => {
    const body = leadgenWebhookBody({ leadgenId: 'lg_9', pageId: 'p', formId: 'f', adId: 'a', adsetId: 's' })
    expect(signBody(body, 'test-secret')).toBe('sha256=' + createHmac('sha256', 'test-secret').update(body).digest('hex'))
    const value = JSON.parse(body).entry[0].changes[0].value
    expect(value).toEqual({ leadgen_id: 'lg_9', page_id: 'p', form_id: 'f', ad_id: 'a', adgroup_id: 's' })
  })

  it('carries a Graph-shaped fixture lead only when asked', () => {
    const plain = JSON.parse(leadgenWebhookBody({ leadgenId: 'lg_1' })).entry[0].changes[0].value
    expect(plain.fixture_lead).toBeUndefined()
    const fx = JSON.parse(leadgenWebhookBody({ leadgenId: 'lg_1', fixture: { campaign_name: 'C' } })).entry[0].changes[0].value
    expect(fx.fixture_lead).toEqual({ id: 'lg_1', campaign_name: 'C' })
  })
})

describe('ad account allowlist in the CLI (campaigns, spend, check-token)', () => {
  const env = { META_ALLOWED_AD_ACCOUNTS: 'act_1742876583597558' }
  it('campaigns/spend read only an allowlisted META_AD_ACCOUNT_ID', async () => {
    const { cliAdAccount } = await import('../tools/meta-lib.mjs')
    expect(cliAdAccount({ ...env, META_AD_ACCOUNT_ID: '1742876583597558' })).toEqual({ ok: true, act: 'act_1742876583597558' })
    const refused = cliAdAccount({ ...env, META_AD_ACCOUNT_ID: 'act_999000111222333' })
    expect(refused.ok).toBe(false)
    expect(JSON.stringify(refused)).not.toContain('999000111222333')
    expect(cliAdAccount({ META_AD_ACCOUNT_ID: 'act_1742876583597558' }).ok).toBe(false) // no allowlist: fail closed
    expect(cliAdAccount({ META_ALLOWED_AD_ACCOUNTS: 'act_1742876583597558,bad', META_AD_ACCOUNT_ID: 'act_1742876583597558' }).ok).toBe(false)
    expect(cliAdAccount({ ...env, META_AD_ACCOUNT_ID: 'act%5F999000111222333' }).ok).toBe(false)
  })
  it('check-token prints approved ad account ids plus a count of the others', async () => {
    const { allowedAdAccounts, describeGranularTargets } = await import('../tools/meta-lib.mjs')
    const allowed = allowedAdAccounts(env)
    const line = describeGranularTargets({ scope: 'ads_read', targets: ['1742876583597558', '999000111222333', '77777'] }, allowed)
    expect(line).toBe('act_1742876583597558 plus 2 other account(s)')
    expect(line).not.toContain('999000111222333')
    expect(describeGranularTargets({ scope: 'ads_read', targets: ['999000111222333'] }, null)).toBe('no approved account plus 1 other account(s)')
    expect(describeGranularTargets({ scope: 'pages_show_list', targets: ['1333173556539688'] }, allowed)).toBe('1333173556539688')
    expect(describeGranularTargets({ scope: 'ads_read', targets: [] }, allowed)).toBe('all')
  })
})
