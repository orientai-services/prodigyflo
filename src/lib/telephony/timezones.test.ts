import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import NANP from './data/nanp-timezones.json'
import {
  DEFAULT_WINDOW,
  FEDERAL_HOLIDAYS,
  LEGAL_WINDOW,
  STATE_WINDOWS,
  calleeZones,
  clampWindow,
  deferUntil,
  localTimeIn,
  windowOk,
  zonesForNumber,
} from './timezones'

/**
 * Calling hours in the callee's own time (docs/TELEPHONY_LIVE.md §2.7, §8.1).
 * All instants are absolute (UTC) so the tests mean the same thing wherever
 * they run.
 */

const PT = 'America/Los_Angeles'
const ET = 'America/New_York'

describe('the vendored area-code data', () => {
  it('records its source, commit and checksum, and the entry count matches', () => {
    const data = NANP as { source: string; commit: string; sha256: string; license: string; count: number; entries: Record<string, string[]> }
    expect(data.source).toContain(data.commit)
    expect(data.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(data.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(data.license).toContain('Apache-2.0')
    expect(Object.keys(data.entries)).toHaveLength(data.count)
    expect(data.count).toBeGreaterThan(1000)
    // Every prefix is NANP and at least a full area code; the bare "1" is not kept.
    expect(Object.keys(data.entries).every((k) => /^1\d{3,}$/.test(k))).toBe(true)
  })

  it('a checksum of the entries is stable (catches hand edits)', () => {
    const digest = createHash('sha256').update(JSON.stringify((NANP as { entries: unknown }).entries)).digest('hex')
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('zones for a number', () => {
  it('a single-zone prefix', () => {
    expect(zonesForNumber('+17025550142')).toEqual([PT])
    expect(zonesForNumber('+12125550142')).toEqual([ET])
  })

  it('a multi-zone prefix keeps every zone', () => {
    expect(zonesForNumber('+19075550142').sort()).toEqual(['America/Adak', 'America/Anchorage'])
  })

  it('non-geographic and foreign numbers are unknown', () => {
    expect(zonesForNumber('+18005550142')).toEqual([])
    expect(zonesForNumber('+15555550142')).toEqual([])
    expect(zonesForNumber('+442071838750')).toEqual([])
    expect(zonesForNumber(null)).toEqual([])
  })
})

describe('callee zones are the union of every hint', () => {
  it('area code says Pacific, state says Eastern → both', () => {
    expect(calleeZones({ e164: '+17025550142', states: ['New York'] }).zones).toEqual([PT, ET])
  })

  it('a zone staff set is added, never a replacement', () => {
    expect(calleeZones({ leadZone: 'America/Chicago', e164: '+17025550142' }).zones).toEqual(['America/Chicago', PT])
  })

  it('outOfArea alone adds nothing, and nothing is ever assumed', () => {
    expect(calleeZones({ outOfArea: true }).zones).toEqual([])
    expect(calleeZones({}).zones).toEqual([])
  })

  it('normalizes state names the same way the Meta intake does', () => {
    expect(calleeZones({ states: ['tx'] }).states).toEqual(['TX'])
    expect(calleeZones({ states: ['Arizona', 'nonsense'] }).states).toEqual(['AZ'])
  })
})

describe('the window', () => {
  // 2026-10-07 is a Wednesday. Pacific is UTC-7 (PDT).
  const at = (hh: number, mm: number) => new Date(Date.UTC(2026, 9, 7, hh + 7, mm))

  it('7:59 refused, 8:00 allowed, 19:59 allowed, 20:00 refused (default window, callee-local)', () => {
    expect(windowOk([PT], at(7, 59), DEFAULT_WINDOW, 'marketing').ok).toBe(false)
    expect(windowOk([PT], at(8, 0), DEFAULT_WINDOW, 'marketing').ok).toBe(true)
    expect(windowOk([PT], at(19, 59), DEFAULT_WINDOW, 'marketing').ok).toBe(true)
    expect(windowOk([PT], at(20, 0), DEFAULT_WINDOW, 'marketing').ok).toBe(false)
  })

  it('must be inside the window in EVERY zone', () => {
    // 8:30 am Pacific is 11:30 am Eastern: fine. 6:30 pm Pacific is 9:30 pm Eastern: not.
    expect(windowOk([PT, ET], at(8, 30), DEFAULT_WINDOW, 'servicing').ok).toBe(true)
    const late = windowOk([PT, ET], at(18, 30), DEFAULT_WINDOW, 'servicing')
    expect(late.ok).toBe(false)
    if (!late.ok) expect(late.failures.map((f) => f.zone)).toEqual([ET])
  })

  it('respects DST: 8:00 local on both sides of the November change', () => {
    // Sat 31 Oct 2026 is PDT (UTC-7); Mon 2 Nov 2026 is PST (UTC-8).
    expect(localTimeIn(PT, new Date('2026-10-31T15:00:00Z')).hour).toBe(8)
    expect(localTimeIn(PT, new Date('2026-11-02T16:00:00Z')).hour).toBe(8)
    expect(windowOk([PT], new Date('2026-11-02T15:59:00Z'), DEFAULT_WINDOW, 'servicing').ok).toBe(false)
    expect(windowOk([PT], new Date('2026-11-02T16:00:00Z'), DEFAULT_WINDOW, 'servicing').ok).toBe(true)
  })

  it('marketing skips Sundays; servicing does not', () => {
    const sundayNoonPT = new Date('2026-10-11T19:00:00Z')
    const marketing = windowOk([PT], sundayNoonPT, DEFAULT_WINDOW, 'marketing')
    expect(marketing.ok).toBe(false)
    if (!marketing.ok) expect(marketing.failures[0].reason).toBe('sunday')
    expect(windowOk([PT], sundayNoonPT, DEFAULT_WINDOW, 'servicing').ok).toBe(true)
  })

  it('marketing skips every federal holiday (noon Pacific on the day)', () => {
    for (const h of FEDERAL_HOLIDAYS(2026)) {
      const noon = new Date(`${h.date}T19:00:00Z`)
      const res = windowOk([PT], noon, DEFAULT_WINDOW, 'marketing')
      expect(res.ok, h.name).toBe(false)
    }
  })

  it('the account window can be narrowed but never past the legal ceiling', () => {
    expect(clampWindow({ start: 6, end: 23 })).toEqual(LEGAL_WINDOW)
    expect(clampWindow({ start: 10, end: 17 })).toEqual({ start: 10, end: 17 })
    expect(clampWindow({ start: 18, end: 9 })).toEqual(DEFAULT_WINDOW)
    expect(clampWindow(null)).toEqual(DEFAULT_WINDOW)
  })

  it('STATE_WINDOWS narrows and never widens', () => {
    expect(STATE_WINDOWS).toEqual({}) // ships empty: every entry needs a cited rule
    STATE_WINDOWS.ZZ = { days: { 3: { start: 9, end: 12 } }, source: 'test only' }
    try {
      // Wednesday 8:30 am: inside the default window, outside the state's 9–12.
      expect(windowOk([PT], at(8, 30), DEFAULT_WINDOW, 'servicing', ['ZZ']).ok).toBe(false)
      expect(windowOk([PT], at(9, 30), DEFAULT_WINDOW, 'servicing', ['ZZ']).ok).toBe(true)
      // A state rule wider than the ceiling still can't reach 9:30 pm.
      STATE_WINDOWS.ZZ = { days: { 3: { start: 6, end: 23 } }, source: 'test only' }
      expect(windowOk([PT], at(21, 30), LEGAL_WINDOW, 'servicing', ['ZZ']).ok).toBe(false)
      STATE_WINDOWS.ZZ = { days: { 3: null }, source: 'test only' }
      const closed = windowOk([PT], at(12, 0), DEFAULT_WINDOW, 'servicing', ['ZZ'])
      expect(closed.ok).toBe(false)
      if (!closed.ok) expect(closed.failures[0].reason).toBe('state_day')
    } finally {
      delete STATE_WINDOWS.ZZ
    }
  })
})

describe('federal holidays', () => {
  const dates = (y: number) => Object.fromEntries(FEDERAL_HOLIDAYS(y).map((h) => [h.name, h.date]))

  it('computes each 2026 holiday', () => {
    const d = dates(2026)
    expect(d["New Year's Day"]).toBe('2026-01-01')
    expect(d['Martin Luther King Jr. Day']).toBe('2026-01-19')
    expect(d["Washington's Birthday"]).toBe('2026-02-16')
    expect(d['Memorial Day']).toBe('2026-05-25')
    expect(d.Juneteenth).toBe('2026-06-19')
    expect(d['Independence Day']).toBe('2026-07-04')
    expect(d['Independence Day (observed)']).toBe('2026-07-03')
    expect(d['Labor Day']).toBe('2026-09-07')
    expect(d['Columbus Day']).toBe('2026-10-12')
    expect(d['Veterans Day']).toBe('2026-11-11')
    expect(d['Thanksgiving Day']).toBe('2026-11-26')
    expect(d['Christmas Day']).toBe('2026-12-25')
  })

  it('adds the observed weekday when a fixed holiday falls on a weekend', () => {
    const d = dates(2027)
    // 2027-12-25 is a Saturday → observed Friday the 24th; 2027-07-04 is a Sunday → observed Monday the 5th.
    expect(d['Christmas Day (observed)']).toBe('2027-12-24')
    expect(d['Independence Day (observed)']).toBe('2027-07-05')
  })
})

describe('deferring to the next opening', () => {
  it('finds 8:00 am the next morning, callee-local', () => {
    const lateWed = new Date('2026-10-08T04:00:00Z') // Wed 9:00 pm Pacific
    const next = deferUntil(lateWed, [PT], DEFAULT_WINDOW, 'servicing')
    expect(next?.toISOString()).toBe('2026-10-08T15:00:00.000Z') // Thu 8:00 am PDT
  })

  it('skips a Sunday (and here the Monday holiday) for marketing', () => {
    const satNight = new Date('2026-10-11T04:00:00Z') // Sat 9:00 pm Pacific
    // Sunday is out, and Monday 12 Oct 2026 is Columbus Day → Tuesday 8:00 am.
    expect(deferUntil(satNight, [PT], DEFAULT_WINDOW, 'marketing')?.toISOString()).toBe('2026-10-13T15:00:00.000Z')
    expect(deferUntil(satNight, [PT], DEFAULT_WINDOW, 'servicing')?.toISOString()).toBe('2026-10-11T15:00:00.000Z')
  })

  it('has nothing to offer for an unknown zone', () => {
    expect(deferUntil(new Date(), [], DEFAULT_WINDOW, 'servicing')).toBeNull()
  })
})
