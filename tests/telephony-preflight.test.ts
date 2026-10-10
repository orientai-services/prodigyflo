/**
 * "Test connection" (Device.runPreflight) reaches the TwiML App with no
 * custom params. The client/voice webhook must answer it with harmless TwiML
 * (silence + hang-up), only after the same signature/account/app checks as a
 * real call, and must never dial or write a VoiceCall row for it
 * (docs/DIALER_POWER.md, Lane B §3).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'
import { POST as clientVoice } from '@/app/api/telephony/client/voice/route'
import { ACCOUNT, makeOrg, makeUser, sid, signedPost, stubTelephonyEnv } from './fixtures/telephony'

const run = `tpre-${Date.now().toString(36)}`
const APP_SID = `AP${'7'.repeat(32)}`
let n = 0
let orgId = ''
let userId = ''

function preflightReq(params: Record<string, string> = {}, token?: string | null) {
  return signedPost(
    '/api/telephony/client/voice',
    {
      CallSid: sid('CA', run, n++),
      AccountSid: ACCOUNT,
      ApplicationSid: APP_SID,
      From: `client:pf_${orgId}_${userId}`,
      To: '',
      ...params,
    },
    token,
  )
}

beforeAll(async () => {
  const org = await makeOrg(run)
  orgId = org.orgId
  userId = (await makeUser(orgId, run, 'Rep', 'CLOSER')).id
})

beforeEach(() => {
  stubTelephonyEnv(orgId, {
    VOICE_BROWSER_ENABLED: 'true',
    TWILIO_TWIML_APP_SID: APP_SID,
    TWILIO_API_KEY_SID: `SK${'1'.repeat(32)}`,
    TWILIO_API_KEY_SECRET: 'test-only-key-secret',
  })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await db.organization.delete({ where: { id: orgId } })
})

describe('client/voice preflight', () => {
  it('a signed connect with no target gets silence and a hang-up, and no row', async () => {
    const req = preflightReq()
    const callSid = new URLSearchParams(await req.clone().text()).get('CallSid')!
    const res = await clientVoice(req)
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).toContain('<Pause length="8"/>')
    expect(xml).toContain('<Hangup/>')
    expect(xml).not.toMatch(/<Dial|<Number|<Say/)
    expect(await db.voiceCall.count({ where: { callSid } })).toBe(0)
  })

  it('a bad signature is still 403', async () => {
    expect((await clientVoice(preflightReq({}, 'nope'))).status).toBe(403)
  })

  it('a wrong ApplicationSid is still 403', async () => {
    expect((await clientVoice(preflightReq({ ApplicationSid: `AP${'9'.repeat(32)}` }))).status).toBe(403)
  })

  it('a real call shape (target + line) never takes the preflight path', async () => {
    const res = await clientVoice(preflightReq({ target: 'client:nope', line: 'nope' }))
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).not.toContain('<Pause')
    expect(xml).toContain('<Say')
  })
})
