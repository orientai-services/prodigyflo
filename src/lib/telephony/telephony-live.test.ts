import { describe, expect, it } from 'vitest'
import {
  allowUnsignedWebhooks,
  candidateWebhookUrls,
  computeTwilioSignature,
  validateTwilioSignatureAny,
  webhookHostAllowlist,
} from './signature'
import {
  MAX_BROWSER_LEGS,
  RECORDING_NOTICE,
  browserDialTwiml,
  outboundDialTwiml,
  sayAndHangup,
  teamStepTwiml,
  voicemailTwiml,
  whisperTwiml,
} from './twiml'
import {
  buildA2pStatusRequest,
  buildBalanceRequest,
  buildCallRecordingsRequest,
  buildCustomerProfilesRequest,
  buildFetchCallRequest,
  buildFetchMessageRequest,
  buildListNumbersRequest,
  buildPurchaseRequest,
  buildUpdateWebhooksRequest,
  parseA2pStatus,
  parseBalance,
  parseCallRecordings,
  parseCallStatus,
  parseListNumbersResponse,
  parseMessageStatus,
  parseProfileStatus,
} from './twilio'
import { buildTwilioRequest } from '@/lib/messaging/twilio'

/**
 * Pure pieces of telephony live (docs/TELEPHONY_LIVE.md §8.1): which URLs a
 * signature may match, when the unsigned bypass is honoured, the TwiML each
 * stage answers with, and every Twilio request builder / response mapper.
 * No network: builders are compared as data.
 */

const CREDS = { accountSid: 'AC123', authToken: 'sekret' }
const AUTH = `Basic ${Buffer.from('AC123:sekret').toString('base64')}`

function req(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { method: 'POST', headers })
}

describe('webhook signature candidates', () => {
  const app = 'https://www.prodigyflo.ai'

  it('always tries APP_URL first, with the request path and query', () => {
    const urls = candidateWebhookUrls(req('http://internal:3000/api/telephony/voice/dial?callSid=CA1&stage=team&i=0'), app)
    expect(urls).toEqual(['https://www.prodigyflo.ai/api/telephony/voice/dial?callSid=CA1&stage=team&i=0'])
  })

  it('adds a forwarded host only when it is APP_URL’s host or allowlisted', () => {
    const preview = req('http://internal/api/telephony/voice', { 'x-forwarded-host': 'pf-git-x.vercel.app' })
    expect(candidateWebhookUrls(preview, app, ['pf-git-x.vercel.app'])).toEqual([
      'https://www.prodigyflo.ai/api/telephony/voice',
      'https://pf-git-x.vercel.app/api/telephony/voice',
    ])
  })

  it('never trusts an arbitrary forwarded host', () => {
    const evil = req('http://internal/api/telephony/voice', { 'x-forwarded-host': 'evil.example' })
    expect(candidateWebhookUrls(evil, app, ['pf-git-x.vercel.app'])).toEqual(['https://www.prodigyflo.ai/api/telephony/voice'])
  })

  it('validates against any candidate and refuses a signature for a host we do not trust', () => {
    const params = { CallSid: 'CA1', To: '+17025550142' }
    const goodHeader = computeTwilioSignature('tok', 'https://pf-git-x.vercel.app/api/telephony/voice', params)
    const urls = candidateWebhookUrls(req('http://i/api/telephony/voice', { 'x-forwarded-host': 'pf-git-x.vercel.app' }), app, ['pf-git-x.vercel.app'])
    expect(validateTwilioSignatureAny({ authToken: 'tok', urls, params, header: goodHeader })).toBe(true)

    const evilHeader = computeTwilioSignature('tok', 'https://evil.example/api/telephony/voice', params)
    const evilUrls = candidateWebhookUrls(req('http://i/api/telephony/voice', { 'x-forwarded-host': 'evil.example' }), app)
    expect(validateTwilioSignatureAny({ authToken: 'tok', urls: evilUrls, params, header: evilHeader })).toBe(false)
  })

  it('reads the extra hosts from TELEPHONY_WEBHOOK_HOSTS', () => {
    expect(webhookHostAllowlist({ TELEPHONY_WEBHOOK_HOSTS: ' A.example , b.example,' })).toEqual(['a.example', 'b.example'])
    expect(webhookHostAllowlist({})).toEqual([])
  })
})

describe('the unsigned-webhook bypass', () => {
  const dev = { TELEPHONY_ALLOW_UNSIGNED_WEBHOOKS: 'true', NODE_ENV: 'development', TELEPHONY_PROVIDER: 'mock' }

  it('is honoured only in local development with the mock carrier', () => {
    expect(allowUnsignedWebhooks(dev)).toBe(true)
  })

  it('is refused under NODE_ENV=production', () => {
    expect(allowUnsignedWebhooks({ ...dev, NODE_ENV: 'production' })).toBe(false)
  })

  it('is refused under VERCEL_ENV=production', () => {
    expect(allowUnsignedWebhooks({ ...dev, VERCEL_ENV: 'production' })).toBe(false)
  })

  it('is refused with the real carrier', () => {
    expect(allowUnsignedWebhooks({ ...dev, TELEPHONY_PROVIDER: 'twilio' })).toBe(false)
  })

  it('is off unless asked for', () => {
    expect(allowUnsignedWebhooks({ NODE_ENV: 'development', TELEPHONY_PROVIDER: 'mock' })).toBe(false)
  })
})

describe('inbound TwiML stages', () => {
  const leg = (n: number) => ({
    identity: `pf_org1_user${n}`,
    params: { pfCallId: 'CA1', pfCaller: '•••-•••-1234', pfLine: 'Main line', pfTarget: 'lead:abc' },
  })

  it('rings at most five browsers, each with its parameters', () => {
    const xml = browserDialTwiml({ legs: [1, 2, 3, 4, 5, 6, 7].map(leg), actionUrl: 'https://x/dial?stage=browser', recordCalls: false })
    expect(xml.match(/<Client/g)).toHaveLength(MAX_BROWSER_LEGS)
    expect(xml).toContain('<Identity>pf_org1_user1</Identity>')
    expect(xml).not.toContain('pf_org1_user6')
    expect(xml).toContain('<Parameter name="pfCallId" value="CA1"/>')
    expect(xml).toContain('<Parameter name="pfTarget" value="lead:abc"/>')
    expect(xml).toContain('answerOnBridge="true"')
  })

  it('rings exactly one browser while the account is limited to one call', () => {
    const xml = browserDialTwiml({ legs: [1, 2, 3].map(leg), actionUrl: 'https://x/dial', recordCalls: false, limited: true })
    expect(xml.match(/<Client/g)).toHaveLength(1)
  })

  it('a TEAM step dials one number, no greeting', () => {
    const xml = teamStepTwiml({ number: '+17025550222', actionUrl: 'https://x/dial?stage=team&i=1', recordCalls: false })
    expect(xml.match(/<Number/g)).toHaveLength(1)
    expect(xml).not.toContain('<Say')
    expect(xml).toContain('action="https://x/dial?stage=team&amp;i=1"')
  })

  it('voicemail posts both the action and the status callback to the recording route', () => {
    const xml = voicemailTwiml({ voicemailCallbackUrl: 'https://x/rec?callSid=CA1&kind=voicemail', skipGreeting: true })
    expect(xml).toContain('<Record')
    expect(xml).toContain('recordingStatusCallback="https://x/rec?callSid=CA1&amp;kind=voicemail"')
    expect(xml).not.toContain('Thanks for calling')
  })

  it('escapes every value it writes', () => {
    const xml = browserDialTwiml({
      legs: [{ identity: 'pf_a_b', params: { pfCaller: 'Tom & "Jerry" <x>' } }],
      actionUrl: 'https://x/dial?a=1&b=2',
      recordCalls: true,
      greeting: "It's <us>",
    })
    expect(xml).toContain('value="Tom &amp; &quot;Jerry&quot; &lt;x&gt;"')
    expect(xml).toContain('It&apos;s &lt;us&gt;')
    expect(xml).toContain('action="https://x/dial?a=1&amp;b=2"')
    expect(xml).toContain(RECORDING_NOTICE)
  })
})

describe('outbound TwiML', () => {
  const base = {
    callerId: '+17025550100',
    callee: '+17025550199',
    actionUrl: 'https://x/client/dial?vc=V1',
    statusUrl: 'https://x/client/status?vc=V1',
    recordingStatusUrl: 'https://x/client/recording?vc=V1',
    whisperUrl: 'https://x/client/whisper?vc=V1',
  }

  it('dials with an honest caller ID and no recording when recording is off', () => {
    const xml = outboundDialTwiml({ ...base, record: false })
    expect(xml).toContain('callerId="+17025550100"')
    expect(xml).toContain('>+17025550199</Number>')
    expect(xml).toContain('statusCallbackEvent="initiated ringing answered completed"')
    expect(xml).not.toContain('record=')
    expect(xml).not.toContain('url=')
  })

  it('records and whispers the notice only when recording is on', () => {
    const xml = outboundDialTwiml({ ...base, record: true })
    expect(xml).toContain('record="record-from-answer-dual"')
    expect(xml).toContain('recordingStatusCallback="https://x/client/recording?vc=V1"')
    expect(xml).toContain('url="https://x/client/whisper?vc=V1"')
  })

  it('the whisper is the recording notice; a refusal is said, then hung up', () => {
    expect(whisperTwiml()).toContain(RECORDING_NOTICE)
    const no = sayAndHangup('No consent on file for this number.')
    expect(no).toContain('No consent on file for this number.')
    expect(no.endsWith('<Hangup/></Response>')).toBe(true)
  })
})

describe('twilio REST builders and mappers', () => {
  it('lists owned numbers 1000 at a time and follows next_page_uri', () => {
    const first = buildListNumbersRequest(CREDS)
    expect(first.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/IncomingPhoneNumbers.json?PageSize=1000')
    expect(first.init.headers).toMatchObject({ Authorization: AUTH })
    const next = buildListNumbersRequest(CREDS, '/2010-04-01/Accounts/AC123/IncomingPhoneNumbers.json?PageSize=1000&Page=1&PageToken=PA1')
    expect(next.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/IncomingPhoneNumbers.json?PageSize=1000&Page=1&PageToken=PA1')
  })

  it('maps owned numbers, skipping rows without a SID or number', () => {
    const out = parseListNumbersResponse({
      incoming_phone_numbers: [
        {
          sid: 'PN1',
          phone_number: '+17025550100',
          friendly_name: 'Main',
          capabilities: { voice: true, sms: true, mms: false },
          voice_url: 'https://www.prodigyflo.ai/api/telephony/voice',
          sms_url: null,
          status_callback: '',
          voice_fallback_url: null,
          date_created: 'Tue, 07 Oct 2026 10:00:00 +0000',
        },
        { sid: 'PN2' },
      ],
      next_page_uri: null,
    })
    expect(out.nextPageUri).toBeNull()
    expect(out.numbers).toEqual([
      {
        sid: 'PN1',
        e164: '+17025550100',
        friendlyName: 'Main',
        capabilities: { voice: true, sms: true, mms: false },
        voiceUrl: 'https://www.prodigyflo.ai/api/telephony/voice',
        smsUrl: null,
        statusCallback: null,
        voiceFallbackUrl: null,
        dateCreated: 'Tue, 07 Oct 2026 10:00:00 +0000',
      },
    ])
  })

  it('repoints a number: voice, status, SMS and the fallback', () => {
    const { url, init } = buildUpdateWebhooksRequest(
      'PN1',
      { voiceUrl: 'https://a/voice', voiceStatusUrl: 'https://a/status', smsUrl: 'https://a/sms', voiceFallbackUrl: 'https://handler.twilio.com/bin' },
      CREDS,
    )
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/IncomingPhoneNumbers/PN1.json')
    const body = new URLSearchParams(init.body as string)
    expect(body.get('VoiceUrl')).toBe('https://a/voice')
    expect(body.get('VoiceMethod')).toBe('POST')
    expect(body.get('StatusCallback')).toBe('https://a/status')
    expect(body.get('SmsUrl')).toBe('https://a/sms')
    expect(body.get('VoiceFallbackUrl')).toBe('https://handler.twilio.com/bin')
  })

  it('buys with the fallback URL when one is set', () => {
    const webhooks = { voiceUrl: 'https://a/v', voiceStatusUrl: 'https://a/s', smsUrl: 'https://a/m' }
    const without = new URLSearchParams(buildPurchaseRequest({ e164: '+17025550142', friendlyName: 'x', webhooks }, CREDS).init.body as string)
    expect(without.has('VoiceFallbackUrl')).toBe(false)
    const withIt = new URLSearchParams(
      buildPurchaseRequest({ e164: '+17025550142', friendlyName: 'x', webhooks: { ...webhooks, voiceFallbackUrl: 'https://bin' } }, CREDS).init.body as string,
    )
    expect(withIt.get('VoiceFallbackUrl')).toBe('https://bin')
  })

  it('reads the balance as money', () => {
    expect(buildBalanceRequest(CREDS).url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Balance.json')
    expect(parseBalance({ balance: '41.2', currency: 'USD' })).toEqual({ balance: '$41.20', currency: 'USD' })
    expect(parseBalance({ balance: '-3.5', currency: 'usd' })).toEqual({ balance: '-$3.50', currency: 'USD' })
    expect(parseBalance({})).toBeNull()
  })

  it('reads a message status with its error code', () => {
    expect(buildFetchMessageRequest('SM1', CREDS).url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM1.json')
    expect(parseMessageStatus({ status: 'Undelivered', error_code: 30034 })).toEqual({ status: 'undelivered', errorCode: '30034' })
    expect(parseMessageStatus({ status: 'delivered', error_code: null })).toEqual({ status: 'delivered', errorCode: null })
    expect(parseMessageStatus(null)).toBeNull()
  })

  it('reads a call status', () => {
    expect(buildFetchCallRequest('CA1', CREDS).url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Calls/CA1.json')
    const parsed = parseCallStatus({ status: 'completed', duration: '42', end_time: 'Wed, 08 Oct 2026 18:00:00 +0000' })
    expect(parsed?.status).toBe('completed')
    expect(parsed?.durationSeconds).toBe(42)
    expect(parsed?.endedAt?.toISOString()).toBe('2026-10-08T18:00:00.000Z')
  })

  it('reads a call’s recordings', () => {
    expect(buildCallRecordingsRequest('CA1', CREDS).url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Calls/CA1/Recordings.json')
    expect(parseCallRecordings({ recordings: [{ sid: 'RE1', duration: '9' }, { duration: '3' }] })).toEqual([{ sid: 'RE1', durationSeconds: 9 }])
  })

  it('reads the business profile: approved wins, else the newest', () => {
    expect(buildCustomerProfilesRequest(CREDS).url).toBe('https://trusthub.twilio.com/v1/CustomerProfiles?PageSize=20')
    expect(parseProfileStatus({ results: [{ status: 'in-review', date_created: '2026-10-01' }, { status: 'twilio-approved', date_created: '2026-09-01' }] })).toBe(
      'twilio-approved',
    )
    expect(parseProfileStatus({ results: [{ status: 'draft', date_created: '2026-09-01' }, { status: 'in-review', date_created: '2026-10-01' }] })).toBe(
      'in-review',
    )
    expect(parseProfileStatus({ results: [] })).toBeNull()
  })

  it('reads A2P per Messaging Service', () => {
    expect(buildA2pStatusRequest('MG1', CREDS).url).toBe('https://messaging.twilio.com/v1/Services/MG1/Compliance/Usa2p')
    expect(parseA2pStatus({ compliance: [{ campaign_status: 'VERIFIED' }] })).toBe('verified')
    expect(parseA2pStatus({ compliance: [] })).toBe('no campaign')
  })

  it('sends a text with BOTH the org’s Messaging Service and its own From, plus a status callback', () => {
    const { init } = buildTwilioRequest(
      { to: '+15550001111', body: 'hi' },
      {
        accountSid: 'AC123',
        authToken: 'tok',
        fromNumber: '+17025550100',
        messagingServiceSid: 'MG0123',
        statusCallback: 'https://www.prodigyflo.ai/api/telephony/sms/status',
      },
    )
    const body = new URLSearchParams(init.body as string)
    expect(body.get('MessagingServiceSid')).toBe('MG0123')
    expect(body.get('From')).toBe('+17025550100')
    expect(body.get('StatusCallback')).toBe('https://www.prodigyflo.ai/api/telephony/sms/status')
  })

  it('sends From only when the org has no Messaging Service', () => {
    const { init } = buildTwilioRequest({ to: '+15550001111', body: 'hi' }, { accountSid: 'AC1', authToken: 't', fromNumber: '+17025550100' })
    const body = new URLSearchParams(init.body as string)
    expect(body.has('MessagingServiceSid')).toBe(false)
    expect(body.get('From')).toBe('+17025550100')
  })
})
