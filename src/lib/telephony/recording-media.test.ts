import { describe, expect, it, vi } from 'vitest'
import { fetchRecordingMedia, mediaHostAllowed, recordingMediaRequest } from './recording-media'

/**
 * The recording proxy's safety checks (docs/TELEPHONY_LIVE.md §2.6): the URL
 * is rebuilt from the call's own account and a validated SID, credentials must
 * be for that same account, and redirects go only to allowlisted hosts —
 * without the Authorization header. No network: fetch is a stub.
 */

const ACCOUNT = `AC${'1'.repeat(32)}`
const OTHER = `AC${'2'.repeat(32)}`
const SID = `RE${'a'.repeat(32)}`
const CREDS = { accountSid: ACCOUNT, authToken: 'tok' }

describe('building the media request', () => {
  it('refuses a bad SID before any fetch', () => {
    expect(recordingMediaRequest({ accountSid: ACCOUNT, recordingSid: 'RE123' }, CREDS, { mono: true })).toEqual({ ok: false, reason: 'bad_sid' })
    expect(recordingMediaRequest({ accountSid: ACCOUNT, recordingSid: `RE${'A'.repeat(32)}` }, CREDS, { mono: true })).toEqual({ ok: false, reason: 'bad_sid' })
    expect(recordingMediaRequest({ accountSid: ACCOUNT, recordingSid: null }, CREDS, { mono: true })).toEqual({ ok: false, reason: 'bad_sid' })
  })

  it('refuses credentials for another account', () => {
    expect(recordingMediaRequest({ accountSid: ACCOUNT, recordingSid: SID }, { accountSid: OTHER, authToken: 'x' }, { mono: true })).toEqual({
      ok: false,
      reason: 'account_mismatch',
    })
  })

  it('builds the URL only from the call’s account and SID, mono by default', () => {
    const built = recordingMediaRequest({ accountSid: ACCOUNT, recordingSid: SID }, CREDS, { mono: true, range: 'bytes=0-1023' })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.request.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Recordings/${SID}.mp3?RequestedChannels=1`)
    expect(built.request.headers.Range).toBe('bytes=0-1023')
    expect(built.request.headers.Authorization).toBe(`Basic ${Buffer.from(`${ACCOUNT}:tok`).toString('base64')}`)
    const original = recordingMediaRequest({ accountSid: ACCOUNT, recordingSid: SID }, CREDS, { mono: false })
    if (original.ok) expect(original.request.url.endsWith('.mp3')).toBe(true)
  })

  it('drops a malformed Range header', () => {
    const built = recordingMediaRequest({ accountSid: ACCOUNT, recordingSid: SID }, CREDS, { mono: true, range: 'bytes=0-10\r\nX-Evil: 1' })
    if (built.ok) expect(built.request.headers.Range).toBeUndefined()
  })
})

describe('the redirect allowlist', () => {
  it('only https Twilio / Twilio CDN / AWS hosts', () => {
    expect(mediaHostAllowed('https://api.twilio.com/x')).toBe(true)
    expect(mediaHostAllowed('https://media.twiliocdn.com/x')).toBe(true)
    expect(mediaHostAllowed('https://com-twilio-recordings.s3.amazonaws.com/x')).toBe(true)
    expect(mediaHostAllowed('http://api.twilio.com/x')).toBe(false)
    expect(mediaHostAllowed('https://evil.example/x')).toBe(false)
    expect(mediaHostAllowed('https://twilio.com.evil.example/x')).toBe(false)
    expect(mediaHostAllowed('https://amazonaws.com/x')).toBe(false)
  })
})

describe('fetching', () => {
  const request = { url: `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Recordings/${SID}.mp3`, headers: { Authorization: 'Basic abc', Range: 'bytes=0-99' } }

  it('forwards Range and passes a 206 through as a stream', async () => {
    const fetchImpl = vi.fn(async () => new Response('partial', { status: 206, headers: { 'content-range': 'bytes 0-99/5000' } }))
    const res = await fetchRecordingMedia(request, { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.status).toBe(206)
      expect(res.headers.get('content-range')).toBe('bytes 0-99/5000')
      expect(res.body).toBeTruthy()
    }
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).Range).toBe('bytes=0-99')
    expect(init.redirect).toBe('manual')
  })

  it('follows a redirect to an allowed host WITHOUT the Authorization header', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://media.twiliocdn.com/r/abc.mp3' } }))
      .mockResolvedValueOnce(new Response('audio', { status: 200 }))
    const res = await fetchRecordingMedia(request, { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(res.ok).toBe(true)
    const [url2, init2] = fetchImpl.mock.calls[1] as [string, RequestInit]
    expect(url2).toBe('https://media.twiliocdn.com/r/abc.mp3')
    expect((init2.headers as Record<string, string>).Authorization).toBeUndefined()
    expect((init2.headers as Record<string, string>).Range).toBe('bytes=0-99')
  })

  it('refuses a redirect to a host that is not allowed', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }))
    const res = await fetchRecordingMedia(request, { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(res).toMatchObject({ ok: false, status: 502 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('stops after two redirects', async () => {
    const hop = () => new Response(null, { status: 302, headers: { location: 'https://media.twiliocdn.com/again' } })
    const fetchImpl = vi.fn().mockImplementation(async () => hop())
    const res = await fetchRecordingMedia(request, { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(res).toMatchObject({ ok: false, status: 502 })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('maps a carrier 404 to 404 and a network failure to 504', async () => {
    const notFound = vi.fn(async () => new Response('', { status: 404 }))
    expect(await fetchRecordingMedia(request, { fetchImpl: notFound as unknown as typeof fetch })).toMatchObject({ ok: false, status: 404 })
    const boom = vi.fn(async () => {
      throw new Error('socket hang up')
    })
    expect(await fetchRecordingMedia(request, { fetchImpl: boom as unknown as typeof fetch })).toMatchObject({ ok: false, status: 504 })
  })
})
