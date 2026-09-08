import { describe, expect, it } from 'vitest'
import { areaCodeOf, formatE164, toE164 } from './provider'
import { mockSearch } from './mock'
import {
  buildPurchaseRequest,
  buildReleaseRequest,
  buildSearchRequest,
  parseSearchResponse,
  purchaseResultFromResponse,
} from './twilio'
import { computeTwilioSignature, twilioSignatureBase, validateTwilioSignature } from './signature'
import { NUMBER_PRICING, money, quoteNumber } from './pricing'
import { checkFunding } from './billing'
import { defaultBillingMode } from './billing-mode'
import { escapeXml, noAnswerTwiml, rejectTwiml, voiceAnswerTwiml } from './twiml'
import { outcomeFromCarrierStatus } from './calls'

const CREDS = { accountSid: 'AC123', authToken: 'sekret' }

describe('phone number formatting', () => {
  it('normalises the shapes a human actually types', () => {
    expect(toE164('(702) 555-0142')).toBe('+17025550142')
    expect(toE164('702.555.0142')).toBe('+17025550142')
    expect(toE164('17025550142')).toBe('+17025550142')
    expect(toE164('+17025550142')).toBe('+17025550142')
    expect(toE164('+442071838750')).toBe('+442071838750')
  })

  it('refuses anything that is not a dialable number', () => {
    expect(toE164('555-0142')).toBeNull()
    expect(toE164('')).toBeNull()
    expect(toE164('not a number')).toBeNull()
  })

  it('renders US numbers for humans and leaves the rest alone', () => {
    expect(formatE164('+17025550142')).toBe('(702) 555-0142')
    expect(formatE164('+442071838750')).toBe('+442071838750')
    expect(areaCodeOf('+17025550142')).toBe('702')
    expect(areaCodeOf('+442071838750')).toBeNull()
  })
})

describe('the mock carrier', () => {
  it('only ever mints numbers inside the reserved 555-01xx fiction block', () => {
    const numbers = mockSearch({ kind: 'LOCAL', areaCode: '702', limit: 12 })
    expect(numbers).toHaveLength(12)
    for (const n of numbers) {
      expect(n.e164).toMatch(/^\+170255501\d{2}$/)
      expect(n.areaCode).toBe('702')
    }
  })

  it('is deterministic — the same search returns the same numbers', () => {
    const a = mockSearch({ kind: 'LOCAL', areaCode: '512', limit: 5 })
    const b = mockSearch({ kind: 'LOCAL', areaCode: '512', limit: 5 })
    expect(a.map((n) => n.e164)).toEqual(b.map((n) => n.e164))
  })

  it('offers toll-free prefixes and marks them as such', () => {
    const numbers = mockSearch({ kind: 'TOLL_FREE', limit: 4 })
    expect(numbers.every((n) => n.kind === 'TOLL_FREE')).toBe(true)
    expect(numbers.every((n) => ['800', '833', '844', '855', '866', '877', '888'].includes(n.areaCode ?? ''))).toBe(true)
  })

  it('terminates on a filter nothing can satisfy', () => {
    expect(mockSearch({ kind: 'LOCAL', areaCode: '702', contains: '999999', limit: 5 })).toEqual([])
  })
})

describe('twilio provisioning requests', () => {
  it('asks only for numbers that can do both SMS and voice', () => {
    const { url, init } = buildSearchRequest({ kind: 'LOCAL', areaCode: '702' }, CREDS)
    expect(url).toContain('/Accounts/AC123/AvailablePhoneNumbers/US/Local.json')
    expect(url).toContain('AreaCode=702')
    expect(url).toContain('SmsEnabled=true')
    expect(url).toContain('VoiceEnabled=true')
    expect(init.headers).toMatchObject({ Authorization: `Basic ${Buffer.from('AC123:sekret').toString('base64')}` })
  })

  it('drops the area code for toll-free, which has none', () => {
    const { url } = buildSearchRequest({ kind: 'TOLL_FREE', areaCode: '702' }, CREDS)
    expect(url).toContain('/TollFree.json')
    expect(url).not.toContain('AreaCode')
  })

  it('sets the webhooks in the same call that buys the number', () => {
    const { url, init } = buildPurchaseRequest(
      {
        e164: '+17025550142',
        friendlyName: 'CYS main line',
        webhooks: {
          voiceUrl: 'https://prodigyflo.ai/api/telephony/voice',
          voiceStatusUrl: 'https://prodigyflo.ai/api/telephony/voice/status',
          smsUrl: 'https://prodigyflo.ai/api/telephony/sms',
        },
      },
      CREDS,
    )
    expect(url).toContain('/Accounts/AC123/IncomingPhoneNumbers.json')
    const body = String(init.body)
    expect(body).toContain('PhoneNumber=%2B17025550142')
    expect(body).toContain('VoiceUrl=https%3A%2F%2Fprodigyflo.ai%2Fapi%2Ftelephony%2Fvoice')
    expect(body).toContain('SmsUrl=https%3A%2F%2Fprodigyflo.ai%2Fapi%2Ftelephony%2Fsms')
  })

  it('releases by SID', () => {
    const { url, init } = buildReleaseRequest('PN123', CREDS)
    expect(url).toContain('/IncomingPhoneNumbers/PN123.json')
    expect(init.method).toBe('DELETE')
  })
})

describe('twilio responses', () => {
  it('maps a purchase to the number it actually bought', () => {
    const res = purchaseResultFromResponse(201, {
      sid: 'PN9f',
      phone_number: '+17025550142',
      region: 'NV',
      locality: 'Las Vegas',
      capabilities: { sms: true, mms: true, voice: true },
    })
    expect(res).toEqual({
      ok: true,
      number: {
        e164: '+17025550142',
        providerSid: 'PN9f',
        capabilities: { sms: true, mms: true, voice: true },
        areaCode: '702',
        region: 'NV',
        locality: 'Las Vegas',
      },
    })
  })

  it("surfaces the carrier's own error rather than inventing one", () => {
    const res = purchaseResultFromResponse(400, { message: 'Number already owned', code: 21_452 })
    expect(res).toEqual({ ok: false, error: 'Number already owned [code 21452]' })
  })

  it('never reports success without a number and a SID', () => {
    expect(purchaseResultFromResponse(201, { sid: 'PN9f' }).ok).toBe(false)
    expect(purchaseResultFromResponse(201, { phone_number: '+17025550142' }).ok).toBe(false)
  })

  it('parses a search page and skips malformed rows', () => {
    const parsed = parseSearchResponse(
      {
        available_phone_numbers: [
          { phone_number: '+17025550142', region: 'NV', locality: 'Las Vegas', capabilities: { SMS: true, MMS: true, voice: true } },
          { region: 'NV' },
        ],
      },
      'LOCAL',
    )
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ e164: '+17025550142', capabilities: { sms: true, mms: true, voice: true } })
  })

  it('treats a non-response as an empty page rather than throwing', () => {
    expect(parseSearchResponse(null, 'LOCAL')).toEqual([])
    expect(parseSearchResponse({ available_phone_numbers: 'nope' }, 'LOCAL')).toEqual([])
  })
})

describe('twilio webhook signatures', () => {
  const url = 'https://prodigyflo.ai/api/telephony/voice'
  const params = { To: '+17025550142', From: '+17025559999', CallSid: 'CA1' }

  it('signs the URL plus every parameter in key order', () => {
    expect(twilioSignatureBase(url, { b: '2', a: '1' })).toBe(`${url}a1b2`)
  })

  it('accepts a correctly signed request', () => {
    const header = computeTwilioSignature('sekret', url, params)
    expect(validateTwilioSignature({ authToken: 'sekret', url, params, header })).toBe(true)
  })

  it('refuses a tampered parameter, a wrong key, and a missing header', () => {
    const header = computeTwilioSignature('sekret', url, params)
    expect(validateTwilioSignature({ authToken: 'sekret', url, params: { ...params, From: '+17025550000' }, header })).toBe(false)
    expect(validateTwilioSignature({ authToken: 'other', url, params, header })).toBe(false)
    expect(validateTwilioSignature({ authToken: 'sekret', url, params, header: null })).toBe(false)
  })

  it('refuses everything when no auth token is configured', () => {
    const header = computeTwilioSignature('sekret', url, params)
    expect(validateTwilioSignature({ authToken: undefined, url, params, header })).toBe(false)
    expect(validateTwilioSignature({ authToken: '', url, params, header })).toBe(false)
  })
})

describe('pricing', () => {
  it('quotes setup plus the first month as due today', () => {
    const q = quoteNumber('LOCAL')
    expect(q.dueTodayCents).toBe(NUMBER_PRICING.LOCAL.setupCents + NUMBER_PRICING.LOCAL.monthlyCents)
    expect(quoteNumber('TOLL_FREE').monthlyCents).toBeGreaterThan(q.monthlyCents)
  })

  it('formats money to the cent, always', () => {
    expect(money(300)).toBe('$3.00')
    expect(money(0)).toBe('$0.00')
    expect(money(123_456)).toBe('$1,234.56')
  })
})

describe('the money gate', () => {
  const wallet = (over: Partial<Parameters<typeof checkFunding>[0]> = {}) => ({
    organizationId: 'org',
    billingMode: 'WALLET' as const,
    balanceCents: 1000,
    reserveCents: 0,
    agencyChargedCents: 0,
    ...over,
  })

  it('lets a funded account buy', () => {
    expect(checkFunding(wallet(), quoteNumber('LOCAL')).ok).toBe(true)
  })

  it('refuses an underfunded account and says exactly how short it is', () => {
    const res = checkFunding(wallet({ balanceCents: 100 }), quoteNumber('LOCAL'))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.shortfallCents).toBe(200)
    expect(res.error).toContain('$2.00')
  })

  it('honours the reserve — a balance is not the same as spendable', () => {
    expect(checkFunding(wallet({ balanceCents: 300, reserveCents: 100 }), quoteNumber('LOCAL')).ok).toBe(false)
  })

  it('never blocks an agency-card account on money', () => {
    const res = checkFunding(wallet({ billingMode: 'AGENCY_CARD', balanceCents: 0 }), quoteNumber('TOLL_FREE'))
    expect(res.ok).toBe(true)
  })
})

describe('which accounts ride the agency card', () => {
  it('puts the agency and the named internal accounts on the card', () => {
    expect(defaultBillingMode({ slug: 'prodigyflo', kind: 'AGENCY' })).toBe('AGENCY_CARD')
    expect(defaultBillingMode({ slug: 'cys', kind: 'CLIENT' })).toBe('AGENCY_CARD')
    expect(defaultBillingMode({ slug: 'SCS', kind: 'CLIENT' })).toBe('AGENCY_CARD')
  })

  it('puts every outside client on a prepaid wallet', () => {
    expect(defaultBillingMode({ slug: 'acme-solar', kind: 'CLIENT' })).toBe('WALLET')
  })
})

describe('what a caller hears', () => {
  const base = {
    recordCalls: false,
    voicemailCallbackUrl: 'https://prodigyflo.ai/api/telephony/voice/recording?callSid=CA1',
    actionUrl: 'https://prodigyflo.ai/api/telephony/voice/dial?callSid=CA1',
  }

  it('rings the forwarding number and can fall through to voicemail', () => {
    const xml = voiceAnswerTwiml({ ...base, routing: 'FORWARD', forwardTo: '+17025550199' })
    expect(xml).toContain('<Number>+17025550199</Number>')
    expect(xml).toContain('action="https://prodigyflo.ai/api/telephony/voice/dial?callSid=CA1"')
    expect(xml).toContain('timeout="20"')
  })

  it('rings a team in the order they were chosen', () => {
    const xml = voiceAnswerTwiml({
      ...base,
      routing: 'TEAM',
      teamNumbers: ['+17025550111', '+17025550222'],
    })
    expect(xml.indexOf('+17025550111')).toBeLessThan(xml.indexOf('+17025550222'))
  })

  it('takes a voicemail when that is the whole plan', () => {
    const xml = voiceAnswerTwiml({ ...base, routing: 'VOICEMAIL_ONLY' })
    expect(xml).toContain('<Record')
    expect(xml).not.toContain('<Dial')
  })

  it('still answers when the line is misconfigured, rather than dropping the call', () => {
    const forward = voiceAnswerTwiml({ ...base, routing: 'FORWARD', forwardTo: null })
    const team = voiceAnswerTwiml({ ...base, routing: 'TEAM', teamNumbers: [] })
    expect(forward).toContain('<Record')
    expect(team).toContain('<Record')
  })

  it('announces recording only when recording is on', () => {
    expect(voiceAnswerTwiml({ ...base, routing: 'VOICEMAIL_ONLY' })).not.toContain('may be recorded')
    expect(voiceAnswerTwiml({ ...base, routing: 'VOICEMAIL_ONLY', recordCalls: true })).toContain('may be recorded')
    expect(voiceAnswerTwiml({ ...base, routing: 'FORWARD', forwardTo: '+17025550199', recordCalls: true })).toContain(
      'record="record-from-answer-dual"',
    )
  })

  it('escapes a greeting so a stray character cannot break the document', () => {
    const xml = voiceAnswerTwiml({ ...base, routing: 'VOICEMAIL_ONLY', greeting: 'Hi <you> & "friends"' })
    expect(xml).toContain('Hi &lt;you&gt; &amp; &quot;friends&quot;')
    expect(escapeXml("it's")).toBe('it&apos;s')
  })

  it('produces well-formed documents for every shape', () => {
    for (const xml of [
      voiceAnswerTwiml({ ...base, routing: 'FORWARD', forwardTo: '+17025550199' }),
      noAnswerTwiml({ ...base, routing: 'FORWARD' }),
      rejectTwiml(),
    ]) {
      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><Response>')).toBe(true)
      expect(xml.endsWith('</Response>')).toBe(true)
    }
  })
})

describe('carrier call status', () => {
  it('maps the carrier vocabulary onto the CRM outcomes', () => {
    expect(outcomeFromCarrierStatus('completed')).toBe('CONNECTED')
    expect(outcomeFromCarrierStatus('busy')).toBe('BUSY')
    expect(outcomeFromCarrierStatus('no-answer')).toBe('NO_ANSWER')
    expect(outcomeFromCarrierStatus('failed')).toBe('FAILED')
    expect(outcomeFromCarrierStatus('canceled')).toBe('DECLINED')
  })

  it('defaults an unknown or missing status to "nobody picked up"', () => {
    expect(outcomeFromCarrierStatus('something-new')).toBe('NO_ANSWER')
    expect(outcomeFromCarrierStatus(null)).toBe('NO_ANSWER')
  })
})
