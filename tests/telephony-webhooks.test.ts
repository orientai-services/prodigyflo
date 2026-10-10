/**
 * Every public /api/telephony/** route (docs/TELEPHONY_LIVE.md §2.2, §4.3):
 * a bad or missing signature is a bare 403 with no DB write; an UNSIGNED
 * request for an unknown line is 403 too (line existence never leaks); only a
 * request signed with the platform token gets the "unknown" answer; a wrong
 * AccountSid is 403; replays are idempotent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const afterQueue = vi.hoisted(() => [] as (() => unknown)[])
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => {
    afterQueue.push(fn)
  },
}))

import { db } from '@/lib/db'
import { POST as voice } from '@/app/api/telephony/voice/route'
import { POST as voiceDial } from '@/app/api/telephony/voice/dial/route'
import { POST as voiceRecording } from '@/app/api/telephony/voice/recording/route'
import { POST as voiceStatus } from '@/app/api/telephony/voice/status/route'
import { POST as sms } from '@/app/api/telephony/sms/route'
import { POST as smsStatus } from '@/app/api/telephony/sms/status/route'
import { POST as clientVoice } from '@/app/api/telephony/client/voice/route'
import { POST as clientDial } from '@/app/api/telephony/client/dial/route'
import { POST as clientStatus } from '@/app/api/telephony/client/status/route'
import { POST as clientRecording } from '@/app/api/telephony/client/recording/route'
import { POST as clientWhisper } from '@/app/api/telephony/client/whisper/route'
import { ACCOUNT, OTHER_ACCOUNT, makeLine, makeOrg, sid, signedPost, stubTelephonyEnv, testNumber } from './fixtures/telephony'

const run = `twh-${Date.now().toString(36)}`
const LINE = testNumber(run, 1)
const CALLER = testNumber(run, 2)
const UNKNOWN_LINE = testNumber(run, 3)

async function drain() {
  while (afterQueue.length) await afterQueue.shift()!()
}

let orgId = ''

beforeAll(async () => {
  const org = await makeOrg(run)
  orgId = org.orgId
  stubTelephonyEnv(orgId)
  await makeLine(orgId, LINE)
})

beforeEach(() => {
  afterQueue.length = 0
  stubTelephonyEnv(orgId)
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await db.organization.delete({ where: { id: orgId } })
})

const voiceParams = (callSid: string, to = LINE) => ({ CallSid: callSid, AccountSid: ACCOUNT, From: CALLER, To: to, CallStatus: 'ringing' })

describe('number webhooks', () => {
  it('a bad signature is 403 and writes nothing', async () => {
    const callSid = sid('CA', run, 'bad')
    const req = signedPost('/api/telephony/voice', voiceParams(callSid), 'not-the-token')
    const res = await voice(req)
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('')
    await drain()
    expect(await db.voiceCall.count({ where: { callSid } })).toBe(0)
  })

  it('an UNSIGNED request for an unknown line is 403, not the polite rejection', async () => {
    const res = await voice(signedPost('/api/telephony/voice', voiceParams(sid('CA', run, 'u1'), UNKNOWN_LINE), null))
    expect(res.status).toBe(403)
    // …and the same for a real line, so a probe can't tell the two apart.
    const real = await voice(signedPost('/api/telephony/voice', voiceParams(sid('CA', run, 'u2')), null))
    expect(real.status).toBe(403)
  })

  it('a request SIGNED with the platform token for an unknown line gets the polite rejection', async () => {
    const res = await voice(signedPost('/api/telephony/voice', voiceParams(sid('CA', run, 'unk'), UNKNOWN_LINE)))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('no longer in service')
  })

  it('a wrong AccountSid is 403 even with a valid signature', async () => {
    const res = await voice(signedPost('/api/telephony/voice', { ...voiceParams(sid('CA', run, 'acct')), AccountSid: OTHER_ACCOUNT }))
    expect(res.status).toBe(403)
  })

  it('the unsigned bypass is ignored in production', async () => {
    vi.stubEnv('TELEPHONY_ALLOW_UNSIGNED_WEBHOOKS', 'true')
    vi.stubEnv('VERCEL_ENV', 'production')
    const res = await voice(signedPost('/api/telephony/voice', voiceParams(sid('CA', run, 'prod')), null))
    expect(res.status).toBe(403)
  })

  it('the happy path answers TwiML and records the call after the response', async () => {
    const callSid = sid('CA', run, 'ok')
    const res = await voice(signedPost('/api/telephony/voice', voiceParams(callSid)))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/xml')
    expect(await res.text()).toContain('<Record')
    expect(await db.voiceCall.count({ where: { callSid } })).toBe(0) // written in after()
    await drain()
    const row = await db.voiceCall.findUniqueOrThrow({ where: { callSid } })
    expect(row).toMatchObject({ organizationId: orgId, accountSid: ACCOUNT, direction: 'INBOUND', lineE164: LINE })
  })

  it('a replayed voice webhook does not duplicate the call', async () => {
    const callSid = sid('CA', run, 'replay')
    await voice(signedPost('/api/telephony/voice', voiceParams(callSid)))
    await voice(signedPost('/api/telephony/voice', voiceParams(callSid)))
    await drain()
    expect(await db.voiceCall.count({ where: { callSid } })).toBe(1)
    const vc = await db.voiceCall.findUniqueOrThrow({ where: { callSid } })
    expect(await db.callCenterEvent.count({ where: { leadId: vc.callCenterLeadId!, type: 'INBOUND', body: { contains: vc.id } } })).toBe(1)
  })

  it('dial / recording: bad signature 403, signed-unknown empty TwiML', async () => {
    for (const [handler, path] of [
      [voiceDial, '/api/telephony/voice/dial?callSid=CAx'],
      [voiceRecording, '/api/telephony/voice/recording?callSid=CAx&kind=voicemail'],
    ] as const) {
      expect((await handler(signedPost(path, voiceParams('CAx'), 'nope'))).status).toBe(403)
      const unknown = await handler(signedPost(path, voiceParams('CAx', UNKNOWN_LINE)))
      expect(unknown.status).toBe(200)
      expect(await unknown.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>')
    }
  })

  it('status: bad signature 403, signed-unknown 204', async () => {
    expect((await voiceStatus(signedPost('/api/telephony/voice/status', voiceParams('CAy'), 'nope'))).status).toBe(403)
    expect((await voiceStatus(signedPost('/api/telephony/voice/status', voiceParams('CAy', UNKNOWN_LINE)))).status).toBe(204)
  })

  it('a replayed recording callback stores one recording', async () => {
    const callSid = sid('CA', run, 'rec')
    await voice(signedPost('/api/telephony/voice', voiceParams(callSid)))
    await drain()
    const recordingSid = sid('RE', run, 'rec')
    const params = { ...voiceParams(callSid), RecordingSid: recordingSid, RecordingDuration: '12', RecordingUrl: 'https://api.twilio.com/should-not-be-stored' }
    const path = `/api/telephony/voice/recording?callSid=${callSid}&kind=voicemail`
    expect((await voiceRecording(signedPost(path, params))).status).toBe(200)
    expect((await voiceRecording(signedPost(path, params))).status).toBe(200)
    await drain()
    const row = await db.voiceCall.findUniqueOrThrow({ where: { callSid } })
    expect(row.recordingSid).toBe(recordingSid)
    expect(row.outcome).toBe('VOICEMAIL')
    expect(JSON.stringify(row)).not.toContain('should-not-be-stored')
  })

  it('inbound SMS: bad signature 403, signed-unknown empty TwiML', async () => {
    const params = { MessageSid: sid('SM', run, 1), AccountSid: ACCOUNT, From: CALLER, To: LINE, Body: 'hi' }
    expect((await sms(signedPost('/api/telephony/sms', params, 'nope'))).status).toBe(403)
    const unknown = await sms(signedPost('/api/telephony/sms', { ...params, To: UNKNOWN_LINE }))
    expect(unknown.status).toBe(200)
  })
})

describe('SMS status callback', () => {
  it('bad signature 403; a status for a message we never sent, signed, is 204', async () => {
    const params = { MessageSid: sid('SM', run, 'st'), MessageStatus: 'delivered', AccountSid: ACCOUNT, From: LINE, To: CALLER }
    expect((await smsStatus(signedPost('/api/telephony/sms/status', params, 'nope'))).status).toBe(403)
    expect((await smsStatus(signedPost('/api/telephony/sms/status', params))).status).toBe(204)
    expect((await smsStatus(signedPost('/api/telephony/sms/status', { ...params, From: UNKNOWN_LINE }))).status).toBe(204)
    expect((await smsStatus(signedPost('/api/telephony/sms/status', { ...params, From: UNKNOWN_LINE }, null))).status).toBe(403)
  })
})

describe('browser-call webhooks (P0b)', () => {
  const identityParams = (from: string) => ({
    CallSid: sid('CA', run, `cv-${from}`),
    AccountSid: ACCOUNT,
    From: from,
    To: '',
    ApplicationSid: `AP${'0'.repeat(32)}`,
    target: 'client:x',
    line: 'y',
  })

  it('client/voice: bad signature 403; signed for an unknown identity says it could not place the call', async () => {
    vi.stubEnv('VOICE_BROWSER_ENABLED', 'true')
    vi.stubEnv('TWILIO_TWIML_APP_SID', `AP${'0'.repeat(32)}`)
    const p = identityParams('client:pf_nosuchorg_nosuchuser')
    expect((await clientVoice(signedPost('/api/telephony/client/voice', p, 'nope'))).status).toBe(403)
    const res = await clientVoice(signedPost('/api/telephony/client/voice', p))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("We couldn&apos;t place this call.")
  })

  it('client/voice: a wrong ApplicationSid is 403', async () => {
    vi.stubEnv('VOICE_BROWSER_ENABLED', 'true')
    vi.stubEnv('TWILIO_TWIML_APP_SID', `AP${'0'.repeat(32)}`)
    const p = { ...identityParams(`client:pf_${orgId}_someone`), ApplicationSid: `AP${'9'.repeat(32)}` }
    expect((await clientVoice(signedPost('/api/telephony/client/voice', p))).status).toBe(403)
  })

  it('dial / status / recording / whisper on an unknown call: 403 unsigned, quiet when signed', async () => {
    const base = { CallSid: 'CAz', AccountSid: ACCOUNT, DialCallStatus: 'completed', CallStatus: 'completed' }
    for (const [handler, path, okStatus] of [
      [clientDial, '/api/telephony/client/dial?vc=nope', 200],
      [clientStatus, '/api/telephony/client/status?vc=nope', 204],
      [clientRecording, '/api/telephony/client/recording?vc=nope', 204],
      [clientWhisper, '/api/telephony/client/whisper?vc=nope', 200],
      [clientStatus, '/api/telephony/client/status?parent=1', 204],
    ] as const) {
      expect((await handler(signedPost(path, base, null))).status).toBe(403)
      expect((await handler(signedPost(path, base))).status).toBe(okStatus)
    }
  })
})
