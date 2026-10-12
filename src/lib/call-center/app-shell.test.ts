import { describe, expect, it } from 'vitest'
import {
  agoLabel,
  badgeText,
  dateLine,
  dueToday,
  filterLeads,
  invalidNumber,
  lastContactAt,
  latestRecording,
  noteSnippet,
  resolveRoute,
  sectionHref,
  shellTitle,
  stageOf,
  todayBadge,
  todayCounts,
  updatedLabel,
  visitLabel,
} from './app-shell'
import { seedLeads, type CallLead } from './model'

// Monday 2026-10-12, 10:00 PDT.
const NOW = new Date('2026-10-12T17:00:00Z')

function lead(patch: Partial<CallLead> = {}): CallLead {
  const base = seedLeads().find((row) => row.name === 'Mara Ellison') as CallLead
  return { ...base, persisted: true, ...patch }
}

describe('dialer routes', () => {
  const allowed = { adsAllowed: true }

  it('opens Today by default and any section by ?s=', () => {
    expect(resolveRoute({}, allowed)).toEqual({ section: 'today', ads: false, filter: null })
    for (const s of ['today', 'messages', 'leads', 'booked', 'history', 'team'] as const) {
      expect(resolveRoute({ s }, allowed).section).toBe(s)
    }
    expect(resolveRoute({ s: 'nope' }, allowed).section).toBe('today')
    expect(resolveRoute({ s: 'toString' }, allowed).section).toBe('today')
    expect(resolveRoute({ s: ['history', 'leads'] }, allowed).section).toBe('history')
  })

  it('maps the old deep links', () => {
    expect(resolveRoute({ tab: 'ads' }, allowed)).toEqual({ section: 'leads', ads: true, filter: null })
    expect(resolveRoute({ tab: 'ads' }, { adsAllowed: false })).toEqual({ section: 'leads', ads: false, filter: null })
    expect(resolveRoute({ tab: 'calendar', view: 'day' }, allowed)).toEqual({ section: 'booked', ads: false, filter: null })
    expect(resolveRoute({ lead: 'cm1' }, allowed)).toEqual({ section: 'leads', ads: false, filter: null })
    expect(resolveRoute({ missed: 'vc1' }, allowed)).toEqual({ section: 'leads', ads: false, filter: 'missed' })
    // The calendar's own links keep it in Booked; the Ads base keeps the dashboard.
    expect(resolveRoute({ s: 'booked', view: 'week', date: '2026-10-12' }, allowed).section).toBe('booked')
    expect(resolveRoute({ s: 'leads', tab: 'ads', view: 'tree' }, allowed)).toEqual({ section: 'leads', ads: true, filter: null })
  })

  it('reads the Leads filter from ?f= and ignores unknown ones', () => {
    expect(resolveRoute({ s: 'leads', f: 'due' }, allowed).filter).toBe('due')
    expect(resolveRoute({ s: 'leads', f: 'uncontacted' }, allowed).filter).toBe('uncontacted')
    expect(resolveRoute({ s: 'leads', f: 'bogus' }, allowed).filter).toBeNull()
    expect(resolveRoute({ s: 'today', f: 'due' }, allowed).filter).toBeNull()
  })

  it('builds section links and titles', () => {
    expect(sectionHref('today')).toBe('/call-center?s=today')
    expect(sectionHref('leads', 'due')).toBe('/call-center?s=leads&f=due')
    expect(sectionHref('leads', 'all')).toBe('/call-center?s=leads')
    expect(shellTitle({ section: 'leads', ads: true })).toBe('Campaigns')
    expect(shellTitle({ section: 'booked', ads: false })).toBe('Booked')
  })
})

describe('Today readings', () => {
  it('counts new not contacted and follow-ups due today or overdue (Pacific)', () => {
    const fresh = lead({ id: 'a', contacted: false, nextAttemptAt: null })
    const tonight = lead({ id: 'b', contacted: true, nextAttemptAt: '2026-10-13T05:00:00Z' }) // 10 pm PDT Monday
    const tomorrow = lead({ id: 'c', contacted: true, nextAttemptAt: '2026-10-13T16:00:00Z' })
    const overdue = lead({ id: 'd', contacted: true, nextAttemptAt: '2026-10-10T16:00:00Z' })
    const dnc = lead({ id: 'e', contacted: false, dnc: true })
    const booked = lead({ id: 'f', contacted: false, status: 'booked' })
    expect(dueToday(tonight, NOW)).toBe(true)
    expect(dueToday(tomorrow, NOW)).toBe(false)
    expect(dueToday(overdue, NOW)).toBe(true)
    const counts = todayCounts([fresh, tonight, tomorrow, overdue, dnc, booked], NOW)
    expect(counts).toEqual({ notContacted: 1, followUps: 2 })
    expect(todayBadge(counts)).toBe(3)
    expect(badgeText(0)).toBeNull()
    expect(badgeText(7)).toBe('7')
    expect(badgeText(120)).toBe('99+')
  })

  it('lists today\'s follow-ups by time for the Follow-ups filter', () => {
    const later = lead({ id: 'x', name: 'Later', contacted: true, nextAttemptAt: '2026-10-12T22:00:00Z' })
    const sooner = lead({ id: 'y', name: 'Sooner', contacted: true, nextAttemptAt: '2026-10-11T22:00:00Z' })
    const none = lead({ id: 'z', name: 'None', contacted: true, nextAttemptAt: null })
    expect(filterLeads([later, none, sooner], 'due', 'all', '', NOW).map((row) => row.id)).toEqual(['y', 'x'])
    expect(filterLeads([later], 'missed', 'all', '', NOW)).toEqual([])
    expect(filterLeads(seedLeads(), 'dnc', 'all', '', NOW).map((row) => row.name)).toEqual(['Riley Cho'])
  })

  it('says the date and the ages in plain words', () => {
    expect(dateLine(NOW)).toBe('Monday, October 12')
    expect(agoLabel(20_000)).toBe('just now')
    expect(agoLabel(12 * 60_000)).toBe('12 min ago')
    expect(agoLabel(3 * 3600_000)).toBe('3 h ago')
    expect(agoLabel(4 * 86400_000 + 5)).toBe('4 d ago')
    expect(updatedLabel(NOW.getTime(), NOW.getTime() + 30_000)).toBe('Updated just now')
    expect(updatedLabel(NOW.getTime(), NOW.getTime() + 180_000)).toBe('Updated 3 min ago')
    expect(visitLabel('2026-10-15T16:00:00Z')).toBe('Thu 9:00 AM')
  })

  it('reads the stage, the last contact, the note, the recording and a bad number', () => {
    expect(stageOf(lead({ contacted: false, nextAttemptAt: null })).label).toBe('NEW')
    expect(stageOf(lead({ status: 'booked' })).label).toBe('BOOKED')
    expect(stageOf(lead({ contacted: true, nextAttemptAt: '2026-10-13T16:00:00Z', followUp: 'callback' })).label).toBe('CALLBACK')
    expect(stageOf(lead({ contacted: true, nextAttemptAt: '2026-10-13T16:00:00Z', followUp: 'cadence' })).label).toBe('RETRY')
    expect(stageOf(lead({ missedCallId: 'vc1' })).label).toBe('MISSED')
    expect(stageOf(lead({ dnc: true })).label).toBe('DO NOT CALL')

    const busy = lead({
      trail: [
        { kind: 'form', at: '2026-10-01T16:00:00Z', label: 'Facebook form', detail: 'Form' },
        { kind: 'call', at: '2026-10-08T16:00:00Z', label: 'Call', detail: 'Answered', recording: { src: '/api/voice/recordings/vc1', seconds: 134 } },
        { kind: 'note', at: '2026-10-08T16:05:00Z', label: 'Note', detail: 'Roof leaks, call 7025550101 after 5' },
        { kind: 'lock', at: '2026-10-09T16:00:00Z', label: 'Lock', detail: 'Took it' },
      ],
    })
    expect(lastContactAt(busy)).toBe(Date.parse('2026-10-08T16:00:00Z'))
    expect(noteSnippet(busy)).toBe('Roof leaks, call ···· after 5')
    expect(noteSnippet(busy, 12)).toBe('Roof leaks,…')
    expect(latestRecording(busy)).toEqual({ src: '/api/voice/recordings/vc1', seconds: 134, at: '2026-10-08T16:00:00Z', length: '2:14' })
    expect(latestRecording(lead({ trail: [] }))).toBeNull()

    expect(invalidNumber(lead({ last4: '4419' }))).toBe(false)
    expect(invalidNumber(lead({ last4: null }))).toBe(true)
    expect(invalidNumber(lead({ trail: [{ kind: 'outcome', at: '2026-10-08T16:00:00Z', label: 'Wrong number', detail: '' }] }))).toBe(true)
    expect(invalidNumber(lead({ last4: null, disabled: true }))).toBe(false)
  })
})
