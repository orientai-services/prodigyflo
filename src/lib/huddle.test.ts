import { describe, expect, it } from 'vitest'
import {
  dayRangeUtc,
  defaultHuddleMode,
  localHour,
  utcFromZoned,
  zonedParts,
} from '@/lib/huddle'

const LA = 'America/Los_Angeles'
const NY = 'America/New_York'

describe('zonedParts', () => {
  it('converts a UTC instant into local wall-clock parts', () => {
    // 2026-08-25T16:30Z is 09:30 PDT (UTC-7).
    const p = zonedParts(new Date('2026-08-25T16:30:00Z'), LA)
    expect(p).toEqual({ year: 2026, month: 8, day: 25, hour: 9, minute: 30 })
  })

  it('crosses the date line for late-evening UTC', () => {
    // 2026-01-15T05:00Z is 21:00 PST on the PREVIOUS local day (UTC-8).
    const p = zonedParts(new Date('2026-01-15T05:00:00Z'), LA)
    expect(p).toEqual({ year: 2026, month: 1, day: 14, hour: 21, minute: 0 })
  })

  it('reads local midnight as hour 0, never 24', () => {
    // 07:00Z in winter = exactly midnight PST.
    const p = zonedParts(new Date('2026-01-15T08:00:00Z'), LA)
    expect(p.hour).toBe(0)
  })

  it('falls back to UTC for an invalid timezone name', () => {
    const p = zonedParts(new Date('2026-08-25T16:30:00Z'), 'Not/AZone')
    expect(p).toEqual({ year: 2026, month: 8, day: 25, hour: 16, minute: 30 })
  })
})

describe('localHour + defaultHuddleMode', () => {
  it('is morning before 14:00 org time', () => {
    const at = new Date('2026-08-25T16:30:00Z') // 09:30 PDT
    expect(localHour(at, LA)).toBe(9)
    expect(defaultHuddleMode(at, LA)).toBe('morning')
  })

  it('is wrap at/after 14:00 org time', () => {
    const at = new Date('2026-08-25T21:00:00Z') // 14:00 PDT sharp
    expect(localHour(at, LA)).toBe(14)
    expect(defaultHuddleMode(at, LA)).toBe('wrap')
  })

  it('depends on the org timezone, not the server clock', () => {
    const at = new Date('2026-08-25T18:30:00Z') // 11:30 PDT / 14:30 EDT
    expect(defaultHuddleMode(at, LA)).toBe('morning')
    expect(defaultHuddleMode(at, NY)).toBe('wrap')
  })
})

describe('utcFromZoned', () => {
  it('maps local midnight to the right UTC instant (PDT, UTC-7)', () => {
    expect(utcFromZoned(LA, 2026, 8, 25).toISOString()).toBe('2026-08-25T07:00:00.000Z')
  })

  it('maps local midnight to the right UTC instant (PST, UTC-8)', () => {
    expect(utcFromZoned(LA, 2026, 1, 15).toISOString()).toBe('2026-01-15T08:00:00.000Z')
  })

  it('handles day rollover in the day argument', () => {
    expect(utcFromZoned(LA, 2026, 8, 32).toISOString()).toBe('2026-09-01T07:00:00.000Z')
  })
})

describe('dayRangeUtc', () => {
  it('bounds the local calendar day containing the instant', () => {
    const { start, end } = dayRangeUtc(new Date('2026-08-25T16:30:00Z'), LA)
    expect(start.toISOString()).toBe('2026-08-25T07:00:00.000Z')
    expect(end.toISOString()).toBe('2026-08-26T07:00:00.000Z')
  })

  it('uses the LOCAL day even when UTC has moved on', () => {
    // 05:00Z on the 26th is still the evening of the 25th in LA.
    const { start, end } = dayRangeUtc(new Date('2026-08-26T05:00:00Z'), LA)
    expect(start.toISOString()).toBe('2026-08-25T07:00:00.000Z')
    expect(end.toISOString()).toBe('2026-08-26T07:00:00.000Z')
  })

  it('shifts whole local days with dayOffset', () => {
    const at = new Date('2026-08-25T16:30:00Z')
    expect(dayRangeUtc(at, LA, -1).start.toISOString()).toBe('2026-08-24T07:00:00.000Z')
    expect(dayRangeUtc(at, LA, 1).start.toISOString()).toBe('2026-08-26T07:00:00.000Z')
    expect(dayRangeUtc(at, LA, 1).end.toISOString()).toBe('2026-08-27T07:00:00.000Z')
  })

  it('carries month and year boundaries', () => {
    const at = new Date('2026-01-01T10:00:00Z') // Jan 1, 02:00 PST
    expect(dayRangeUtc(at, LA, -1).start.toISOString()).toBe('2025-12-31T08:00:00.000Z')
  })

  it('spring-forward day is 23 hours long, fall-back day is 25', () => {
    // US DST 2026: forward Mar 8, back Nov 1.
    const spring = dayRangeUtc(new Date('2026-03-08T20:00:00Z'), LA)
    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * 3_600_000)
    const fall = dayRangeUtc(new Date('2026-11-01T20:00:00Z'), LA)
    expect(fall.end.getTime() - fall.start.getTime()).toBe(25 * 3_600_000)
  })
})
