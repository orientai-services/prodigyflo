import { describe, expect, it } from 'vitest'
import {
  CALLBACK_CONFIRMED,
  CALLBACK_PROMPT,
  RECORDING_NOTICE,
  callbackConfirmedTwiml,
  callbackOfferTwiml,
  voiceAnswerTwiml,
  voicemailTwiml,
} from './twiml'
import { speedAlertsDue, speedClockMinutes, speedClockOpen } from './speed-clock'

/**
 * Pure pieces of the dialer power-up, Lane C (docs/DIALER_POWER.md): the
 * press-1 offer, voicemail transcription in the TwiML, and the speed-to-lead
 * clock. The DB-backed half (routes, dispositions, auto-clear, the sweep) is
 * tests/telephony-dialer-power.test.ts.
 */

const VM = 'https://www.prodigyflo.ai/api/telephony/voice/recording?callSid=CA1&kind=voicemail'
const CB = 'https://www.prodigyflo.ai/api/telephony/voice/callback?callSid=CA1'
const TX = 'https://www.prodigyflo.ai/api/telephony/voice/transcription?callSid=CA1'

describe('press 1 for a callback', () => {
  const twiml = callbackOfferTwiml({ gatherActionUrl: CB, voicemailCallbackUrl: VM, transcribeCallbackUrl: TX })

  it('asks once with a one-digit, five-second Gather that posts to the callback route', () => {
    expect(twiml).toContain('<Gather input="dtmf" numDigits="1" timeout="5" action="https://www.prodigyflo.ai/api/telephony/voice/callback?callSid=CA1" method="POST">')
    expect(twiml).toContain(CALLBACK_PROMPT)
    expect(twiml.match(/<Gather/g)).toHaveLength(1)
  })

  it('falls through to voicemail on silence without asking us again (no actionOnEmptyResult)', () => {
    expect(twiml).not.toContain('actionOnEmptyResult')
    const gatherEnd = twiml.indexOf('</Gather>')
    const record = twiml.indexOf('<Record')
    expect(gatherEnd).toBeGreaterThan(0)
    expect(record).toBeGreaterThan(gatherEnd)
    expect(twiml).toContain(`action="${VM.replace(/&/g, '&amp;')}"`)
    expect(twiml.endsWith('<Hangup/></Response>')).toBe(true)
  })

  it('says no greeting and no second recording notice (both were said on answer)', () => {
    expect(twiml).not.toContain(RECORDING_NOTICE)
    expect(twiml).not.toContain('Please hold')
  })

  it('confirms a pressed 1 and hangs up', () => {
    const done = callbackConfirmedTwiml()
    expect(done).toContain(CALLBACK_CONFIRMED)
    expect(done).toContain('<Hangup/>')
    expect(done).not.toContain('<Record')
  })
})

describe('voicemail transcription in the TwiML', () => {
  it('asks Twilio to transcribe and post to the signed route when a URL is given', () => {
    const twiml = voicemailTwiml({ voicemailCallbackUrl: VM, transcribeCallbackUrl: TX })
    expect(twiml).toContain('transcribe="true"')
    expect(twiml).toContain(`transcribeCallback="${TX}"`)
  })

  it('keeps today’s untranscribed voicemail when transcription is off', () => {
    const twiml = voicemailTwiml({ voicemailCallbackUrl: VM })
    expect(twiml).toContain('transcribe="false"')
    expect(twiml).not.toContain('transcribeCallback')
  })

  it('a VOICEMAIL_ONLY line greets, gives the recording notice, and transcribes', () => {
    const twiml = voiceAnswerTwiml({
      routing: 'VOICEMAIL_ONLY',
      recordCalls: true,
      voicemailCallbackUrl: VM,
      actionUrl: 'https://x/dial',
      transcribeCallbackUrl: TX,
    })
    expect(twiml).toContain(RECORDING_NOTICE)
    expect(twiml).toContain('transcribe="true"')
    expect(twiml).not.toContain('<Gather')
  })
})

describe('the speed-to-lead clock (9:00–20:00 Pacific)', () => {
  // 2026-10-09 is a Friday; Pacific is UTC-7 (PDT).
  const pt = (hhmm: string, day = 9) => new Date(`2026-10-${String(day).padStart(2, '0')}T${hhmm}:00-07:00`)

  it('runs inside the window only', () => {
    expect(speedClockOpen(pt('08:59'))).toBe(false)
    expect(speedClockOpen(pt('09:00'))).toBe(true)
    expect(speedClockOpen(pt('19:59'))).toBe(true)
    expect(speedClockOpen(pt('20:00'))).toBe(false)
  })

  it('counts plain minutes during the day', () => {
    expect(speedClockMinutes(pt('10:00'), pt('10:07'))).toBe(7)
  })

  it('an overnight lead’s clock starts at 9:00', () => {
    const created = pt('23:30', 8)
    expect(speedClockMinutes(created, pt('08:59'))).toBe(0)
    expect(speedClockMinutes(created, pt('09:04'))).toBe(4)
    expect(speedClockMinutes(created, pt('09:05'))).toBe(5)
    expect(speedClockMinutes(pt('07:10'), pt('09:16'))).toBe(16)
  })

  it('pauses at 20:00 and picks up at 9:00', () => {
    const created = pt('19:58', 8)
    expect(speedClockMinutes(created, pt('22:00', 8))).toBe(2)
    expect(speedClockMinutes(created, pt('09:03'))).toBe(5)
  })

  it('alerts at 5 and escalates at 15, each once, only while the clock runs', () => {
    const fresh = { createdAt: pt('10:00'), speedAlertedAt: null, speedEscalatedAt: null }
    expect(speedAlertsDue(fresh, pt('10:04'))).toMatchObject({ alert: false, escalate: false })
    expect(speedAlertsDue(fresh, pt('10:05'))).toMatchObject({ alert: true, escalate: false })
    expect(speedAlertsDue(fresh, pt('10:15'))).toMatchObject({ alert: true, escalate: true })
    const alerted = { ...fresh, speedAlertedAt: pt('10:05') }
    expect(speedAlertsDue(alerted, pt('10:10'))).toMatchObject({ alert: false, escalate: false })
    expect(speedAlertsDue({ ...alerted, speedEscalatedAt: pt('10:15') }, pt('11:00'))).toMatchObject({ alert: false, escalate: false })

    const lateLead = { createdAt: pt('19:50', 8), speedAlertedAt: null, speedEscalatedAt: null }
    // 10 minutes on the clock by 20:00, but nobody is paged at 22:00.
    expect(speedAlertsDue(lateLead, pt('22:00', 8))).toMatchObject({ alert: false, escalate: false })
    expect(speedAlertsDue(lateLead, pt('09:05'))).toMatchObject({ alert: true, escalate: true })
  })

  it('a lead older than 24 hours is no longer new', () => {
    const old = { createdAt: pt('10:00', 7), speedAlertedAt: null, speedEscalatedAt: null }
    expect(speedAlertsDue(old, pt('10:30', 8))).toMatchObject({ alert: false, escalate: false })
  })
})
