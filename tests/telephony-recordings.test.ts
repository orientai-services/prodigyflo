/**
 * GET|HEAD /api/voice/recordings/[voiceCallId] (docs/TELEPHONY_LIVE.md §2.6):
 * signed-in staff only, scoped like the call itself (404, never 403, to anyone
 * else), the URL rebuilt from the call's own account + SID, Range passed
 * through for iOS, ?original=1 for managers only. Fetch is stubbed; nothing
 * reaches Twilio.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ actor: null as unknown }))
vi.mock('@/lib/rbac', async (orig) => ({
  ...(await orig<typeof import('@/lib/rbac')>()),
  getSessionUser: async () => state.actor,
  requireUser: async () => state.actor,
}))
const afterQueue = vi.hoisted(() => [] as (() => unknown)[])
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => {
    afterQueue.push(fn)
  },
}))

import { db } from '@/lib/db'
import { GET, HEAD } from '@/app/api/voice/recordings/[voiceCallId]/route'
import { POST as voice } from '@/app/api/telephony/voice/route'
import { POST as voiceRecording } from '@/app/api/telephony/voice/recording/route'
import { ACCOUNT, OTHER_ACCOUNT, makeLine, makeOrg, makeUser, sid, signedPost, stubTelephonyEnv, testNumber } from './fixtures/telephony'

const run = `trec-${Date.now().toString(36)}`
type User = Awaited<ReturnType<typeof makeUser>>
let orgId = ''
let owner: User
let rep: User
let otherRep: User
let callId = ''
let badSidCallId = ''
let otherAccountCallId = ''
let fetchCalls: { url: string; init: RequestInit }[] = []

function get(id: string, query = '', headers: Record<string, string> = {}) {
  return GET(new Request(`http://localhost/api/voice/recordings/${id}${query}`, { headers }), { params: Promise.resolve({ voiceCallId: id }) })
}

beforeAll(async () => {
  const org = await makeOrg(run)
  orgId = org.orgId
  stubTelephonyEnv(orgId)
  owner = await makeUser(orgId, run, 'Owner', 'SUPER_ADMIN')
  rep = await makeUser(orgId, run, 'Rep', 'CLOSER')
  otherRep = await makeUser(orgId, run, 'Other Rep', 'CLOSER')
  const base = { organizationId: orgId, accountSid: ACCOUNT, direction: 'OUTBOUND' as const, status: 'completed', userId: rep.id }
  callId = (await db.voiceCall.create({ data: { ...base, callSid: sid('CA', run, 1), recordingSid: sid('RE', run, 1), recordingKind: 'call' } })).id
  badSidCallId = (await db.voiceCall.create({ data: { ...base, callSid: sid('CA', run, 2), recordingSid: 'RE-not-valid' } })).id
  otherAccountCallId = (
    await db.voiceCall.create({ data: { ...base, accountSid: OTHER_ACCOUNT, callSid: sid('CA', run, 3), recordingSid: sid('RE', run, 3) } })
  ).id
})

beforeEach(() => {
  stubTelephonyEnv(orgId)
  fetchCalls = []
  afterQueue.length = 0
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    fetchCalls.push({ url, init: init ?? {} })
    if (!url.startsWith('https://api.twilio.com/')) throw new Error(`unexpected network call to ${url}`)
    const range = (init?.headers as Record<string, string> | undefined)?.Range
    if (range) return new Response('partial-audio', { status: 206, headers: { 'content-range': 'bytes 0-12/5000', 'content-length': '13', 'accept-ranges': 'bytes' } })
    return new Response('the-whole-audio', { status: 200, headers: { 'content-length': '15' } })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  state.actor = null
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await db.organization.delete({ where: { id: orgId } })
})

describe('who may play a recording', () => {
  it('the owner (telephony:manage) streams it, as mono, with Basic auth to the call’s own account', async () => {
    state.actor = owner.actor
    const res = await get(callId)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600')
    expect(res.headers.get('content-disposition')).toBe('inline')
    expect(await res.text()).toBe('the-whole-audio')
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Recordings/${sid('RE', run, 1)}.mp3?RequestedChannels=1`)
    expect(fetchCalls[0].init.redirect).toBe('manual')
  })

  it('the rep who placed the call may play it', async () => {
    state.actor = rep.actor
    expect((await get(callId)).status).toBe(200)
  })

  it('another rep, out of scope, gets 404 and nothing is fetched', async () => {
    state.actor = otherRep.actor
    expect((await get(callId)).status).toBe(404)
    expect(fetchCalls).toHaveLength(0)
  })

  it('signed out is 401', async () => {
    state.actor = null
    expect((await get(callId)).status).toBe(401)
  })

  it('?original=1 is managers only: 404 for a rep, the dual file as a download for the owner', async () => {
    state.actor = rep.actor
    expect((await get(callId, '?original=1')).status).toBe(404)
    state.actor = owner.actor
    const res = await get(callId, '?original=1')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(fetchCalls.at(-1)?.url.endsWith('.mp3')).toBe(true)
  })
})

describe('the media request', () => {
  it('a Range request comes back 206 with Content-Range (iOS Safari needs it)', async () => {
    state.actor = owner.actor
    const res = await get(callId, '', { range: 'bytes=0-12' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-12/5000')
    expect((fetchCalls[0].init.headers as Record<string, string>).Range).toBe('bytes=0-12')
  })

  it('HEAD answers without a body', async () => {
    state.actor = owner.actor
    const res = await HEAD(new Request(`http://localhost/api/voice/recordings/${callId}`, { method: 'HEAD' }), { params: Promise.resolve({ voiceCallId: callId }) })
    expect(res.status).toBe(200)
    expect(fetchCalls[0].init.method).toBe('HEAD')
  })

  it('a bad stored SID is 404 with no fetch', async () => {
    state.actor = owner.actor
    expect((await get(badSidCallId)).status).toBe(404)
    expect(fetchCalls).toHaveLength(0)
  })

  it('a call on another Twilio account is 404 with no fetch', async () => {
    state.actor = owner.actor
    expect((await get(otherAccountCallId)).status).toBe(404)
    expect(fetchCalls).toHaveLength(0)
  })
})

describe('a recorded answered call (Dial recording callback has no To)', () => {
  it('is matched through ?callSid= and stored by SID', async () => {
    const line = testNumber(run, 1)
    await makeLine(orgId, line, { routing: 'FORWARD', forwardTo: testNumber(run, 2), recordCalls: true })
    const cs = sid('CA', run, 'dialrec')
    await voice(signedPost('/api/telephony/voice', { CallSid: cs, AccountSid: ACCOUNT, From: testNumber(run, 3), To: line, CallStatus: 'ringing' }))
    while (afterQueue.length) await afterQueue.shift()!()
    const recSid = sid('RE', run, 'dialrec')
    const res = await voiceRecording(
      signedPost(`/api/telephony/voice/recording?callSid=${cs}&kind=call`, {
        AccountSid: ACCOUNT,
        CallSid: cs,
        RecordingSid: recSid,
        RecordingStatus: 'completed',
        RecordingDuration: '61',
      }),
    )
    expect(res.status).toBe(200)
    const vc = await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })
    expect(vc).toMatchObject({ recordingSid: recSid, recordingKind: 'call', recordingDurationSeconds: 61, recordingExpected: true })
  })
})
