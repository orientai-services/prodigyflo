import { describe, expect, it } from 'vitest'
import {
  buildResendRequest,
  resendResultFromResponse,
  RESEND_ENDPOINT,
  RESEND_USER_AGENT,
} from './resend'
import { buildTwilioRequest, twilioResultFromResponse } from './twilio'

describe('resend request builder', () => {
  const msg = { to: 'maria@example.com', subject: 'Your documents', body: 'Hello Maria' }
  const config = { apiKey: 're_test_123', from: 'ProdigyFlo <no-reply@prodigyflo.ai>' }

  it('posts JSON to the emails endpoint with bearer auth', () => {
    const { url, init } = buildResendRequest(msg, config)
    expect(url).toBe(RESEND_ENDPOINT)
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer re_test_123')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('always sends a User-Agent header (Resend rejects requests without one)', () => {
    const { init } = buildResendRequest(msg, config)
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(RESEND_USER_AGENT)
  })

  it('shapes the payload as from/to-array/subject/text', () => {
    const { init } = buildResendRequest(msg, config)
    expect(JSON.parse(init.body as string)).toEqual({
      from: config.from,
      to: ['maria@example.com'],
      subject: 'Your documents',
      text: 'Hello Maria',
    })
  })
})

describe('resend response mapping', () => {
  it('maps 2xx with an id to SENT with that ref', () => {
    expect(resendResultFromResponse(200, { id: 'em_abc' })).toEqual({
      status: 'SENT',
      externalRef: 'em_abc',
    })
  })

  it('maps an API error to FAILED with the provider message and name', () => {
    const result = resendResultFromResponse(422, {
      statusCode: 422,
      name: 'validation_error',
      message: 'Invalid `from` field.',
    })
    expect(result.status).toBe('FAILED')
    expect(result.externalRef).toBeNull()
    expect(result.error).toContain('Invalid `from` field.')
    expect(result.error).toContain('validation_error')
  })

  it('maps a non-JSON error body to FAILED with the HTTP status', () => {
    const result = resendResultFromResponse(500, null)
    expect(result.status).toBe('FAILED')
    expect(result.error).toContain('HTTP 500')
  })
})

describe('twilio request builder', () => {
  const msg = { to: '+15550001111', body: 'Reminder: appointment tomorrow' }
  const config = { accountSid: 'AC123', authToken: 'tok456', fromNumber: '+15559990000' }

  it('posts form-encoded params to the account Messages endpoint', () => {
    const { url, init } = buildTwilioRequest(msg, config)
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    )
    const params = new URLSearchParams(init.body as string)
    expect(params.get('To')).toBe('+15550001111')
    expect(params.get('From')).toBe('+15559990000')
    expect(params.get('Body')).toBe('Reminder: appointment tomorrow')
  })

  it('uses basic auth of accountSid:authToken', () => {
    const { init } = buildTwilioRequest(msg, config)
    const expected = `Basic ${Buffer.from('AC123:tok456').toString('base64')}`
    expect((init.headers as Record<string, string>).Authorization).toBe(expected)
  })
})

describe('twilio response mapping', () => {
  it('maps 201 queued to SENT with the message sid', () => {
    expect(twilioResultFromResponse(201, { sid: 'SM789', status: 'queued' })).toEqual({
      status: 'SENT',
      externalRef: 'SM789',
    })
  })

  it('maps a Twilio error to FAILED with message and code', () => {
    const result = twilioResultFromResponse(400, {
      code: 21211,
      message: "The 'To' number is not a valid phone number.",
      status: 400,
    })
    expect(result.status).toBe('FAILED')
    expect(result.externalRef).toBeNull()
    expect(result.error).toContain('not a valid phone number')
    expect(result.error).toContain('21211')
  })

  it('maps a non-JSON error body to FAILED with the HTTP status', () => {
    const result = twilioResultFromResponse(503, null)
    expect(result.status).toBe('FAILED')
    expect(result.error).toContain('HTTP 503')
  })
})
