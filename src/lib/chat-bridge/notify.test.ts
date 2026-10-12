import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'
import { makeOrg, makeUser } from '../../../tests/fixtures/telephony'
import { clearLinkCache } from './link'
import { buildNoticeEmail, parseChatNotice, PF_CHAT_HOME, safeChatUrl, sendChatNotice } from './notify'
import { signedHeaders } from './sign'

/**
 * The team chat's fallback notice (docs/TEAM_CHAT_PARITY.md F4): parsing and
 * wording are pure; against the test DB the route refuses a bad signature, an
 * unlinked or mismatched uid and a replay, emails once, holds the next one for
 * 3 hours, and never counts the mock mailer as a delivery.
 */

const mail = vi.hoisted(() => ({ mock: false, sent: [] as Array<{ to: string; subject: string; body: string; html?: string }> }))
vi.mock('@/lib/messaging', async (orig) => {
  const real = await orig<typeof import('@/lib/messaging')>()
  return {
    ...real,
    isMockMode: (channel: 'EMAIL' | 'SMS') => (channel === 'EMAIL' ? mail.mock : real.isMockMode(channel)),
    getEmailProvider: () => ({
      name: 'test',
      send: async (m: { to: string; subject: string; body: string; html?: string }) => {
        mail.sent.push(m)
        return { status: 'SENT' as const, externalRef: 'test' }
      },
    }),
  }
})

const KEY = 'test-pf-chat-key-0123456789abcdef0123456789abcdef'
const URL_NOTIFY = 'https://www.prodigyflo.ai/api/bridge/chat/notify'

describe('chat notice parsing', () => {
  it('takes the Worker body, clamps the preview and keeps links on ProdigyFlo', () => {
    const long = 'x'.repeat(400)
    const n = parseChatNotice({ uid: 'u16', pf_user_id: 'usr_1', title: 'Team chat', body: long, url: 'https://evil.example/x', count: 3 })!
    expect(n.body).toHaveLength(140)
    expect(n.url).toBe(PF_CHAT_HOME)
    expect(n.lang).toBe('en')
    expect(parseChatNotice({ uid: 'u16', pf_user_id: 'usr_1', title: 'Chat del equipo', body: 'hola', url: '', count: 1 })!.lang).toBe('es')
    expect(parseChatNotice({ uid: '16', pf_user_id: 'usr_1', body: 'x' })).toBeNull()
    expect(parseChatNotice({ uid: 'u16', pf_user_id: 'a b', body: 'x' })).toBeNull()
    expect(parseChatNotice({ uid: 'u16', pf_user_id: 'usr_1', body: '  ' })).toBeNull()
    expect(safeChatUrl('https://www.prodigyflo.ai/call-center?s=messages#c=c_abc')).toBe('https://www.prodigyflo.ai/call-center?s=messages#c=c_abc')
    expect(safeChatUrl('http://www.prodigyflo.ai/call-center')).toBe(PF_CHAT_HOME)
    expect(safeChatUrl('https://www.prodigyflo.ai.evil.example/')).toBe(PF_CHAT_HOME)
    expect(safeChatUrl('javascript:alert(1)')).toBe(PF_CHAT_HOME)
  })

  it('escapes the preview and links the button to the url', () => {
    const m = buildNoticeEmail({ count: 2, body: '<b>Ana</b> & "you"', url: 'https://www.prodigyflo.ai/call-center?s=messages#c=c_1', lang: 'en' })
    expect(m.subject).toBe('2 unread in Team chat')
    expect(m.html).toContain('&lt;b&gt;Ana&lt;/b&gt; &amp; &quot;you&quot;')
    expect(m.html).not.toContain('<b>Ana</b>')
    expect(m.html).toContain('href="https://www.prodigyflo.ai/call-center?s=messages#c=c_1"')
    expect(buildNoticeEmail({ count: 1, body: 'x', url: PF_CHAT_HOME, lang: 'es' }).subject).toBe('1 mensaje sin leer en el chat del equipo')
  })
})

describe('chat notice route', () => {
  const run = `ccnote-${Date.now().toString(36)}`
  let orgId = ''
  let rep: Awaited<ReturnType<typeof makeUser>>
  let other: Awaited<ReturnType<typeof makeUser>>

  beforeAll(async () => {
    const org = await makeOrg(run, 'Note')
    orgId = org.orgId
    rep = await makeUser(orgId, run, 'Nora Rep', 'CLOSER')
    other = await makeUser(orgId, run, 'Otto Rep', 'CLOSER')
    vi.stubEnv('PF_SUNOFF_BRIDGE_KEY', '')
    vi.stubEnv('PF_CHAT_KEY', KEY)
    vi.stubEnv('CHAT_USER_LINKS', JSON.stringify({ [rep.id]: 16 }))
    clearLinkCache()
  })

  beforeEach(() => {
    mail.sent.length = 0
    mail.mock = false
  })

  afterAll(async () => {
    if (orgId) await db.organization.delete({ where: { id: orgId } })
    vi.unstubAllEnvs()
    clearLinkCache()
  })

  async function post(body: Record<string, unknown>, opts: { key?: string; now?: number; headers?: Record<string, string> } = {}) {
    const { POST } = await import('@/app/api/bridge/chat/notify/route')
    const raw = JSON.stringify(body)
    const headers = opts.headers ?? signedHeaders(opts.key ?? KEY, 'POST', URL_NOTIFY, raw, opts.now)
    const res = await POST(new Request(URL_NOTIFY, { method: 'POST', headers, body: raw }))
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  const notice = (o: Record<string, unknown> = {}) => ({
    uid: 'u16',
    pf_user_id: rep.id,
    title: 'Team chat',
    body: 'You have 3 unread messages in Team chat from Ana.',
    url: 'https://www.prodigyflo.ai/call-center?s=messages#c=c_0123456789abcde',
    count: 3,
    ...o,
  })

  it('refuses unsigned, wrongly signed and unlinked requests', async () => {
    expect((await post(notice(), { headers: { 'content-type': 'application/json' } })).status).toBe(401)
    expect((await post(notice(), { key: 'another-key-0123456789abcdef0123456789abcdef' })).status).toBe(401)
    expect((await post(notice({ uid: 'u17' }))).body).toMatchObject({ ok: false, error: 'not_linked' })
    expect((await post(notice({ pf_user_id: other.id }))).body).toMatchObject({ ok: false, error: 'not_linked' })
    expect((await post({ uid: 'u16' })).status).toBe(400)
    expect(mail.sent).toHaveLength(0)
  })

  it('never counts the mock mailer as a delivery', async () => {
    mail.mock = true
    const r = await post(notice({ count: 9 }))
    expect(r.body).toEqual({ ok: true, sent: false, reason: 'mock' })
  })

  it('emails once, refuses a replay, then holds the next notice for 3 hours', async () => {
    const raw = JSON.stringify(notice())
    const headers = signedHeaders(KEY, 'POST', URL_NOTIFY, raw)
    const first = await post(notice(), { headers })
    expect(first).toEqual({ status: 200, body: { ok: true, sent: true } })
    expect(mail.sent).toHaveLength(1)
    expect(mail.sent[0]).toMatchObject({ to: expect.stringContaining('nora.rep.'), subject: '3 unread in Team chat' })
    expect(mail.sent[0].body).toContain('https://www.prodigyflo.ai/call-center?s=messages#c=c_0123456789abcde')

    const again = await post(notice(), { headers })
    expect(again).toMatchObject({ status: 409, body: { ok: false, error: 'replay' } })

    const later = await post(notice({ count: 5 }), { now: Date.now() + 1000 })
    expect(later.body).toEqual({ ok: true, sent: false, reason: 'recent' })
    expect(mail.sent).toHaveLength(1)

    const rows = await db.auditEvent.findMany({ where: { organizationId: orgId, action: 'chat.fallback_notice' } })
    expect(rows.filter((r) => (r.after as { sent?: boolean }).sent)).toHaveLength(1)
    // Counts and the result only: never the preview text or the address.
    expect(JSON.stringify(rows)).not.toContain('Ana')
    expect(JSON.stringify(rows)).not.toContain('@example.test')
  })

  it('sends again once 3 hours have passed', async () => {
    const r = await sendChatNotice(parseChatNotice(notice())!, 'v1=' + 'a'.repeat(64), new Date(Date.now() + 3 * 3600_000 + 60_000))
    expect(r.body).toEqual({ ok: true, sent: true })
  })
})
