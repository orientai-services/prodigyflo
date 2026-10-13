import { describe, expect, it } from 'vitest'
import { calendarTrailText } from './trail-text'
import { noteSnippet } from '@/lib/call-center/app-shell'
import { seedLeads, type CallLead } from '@/lib/call-center/model'

const REPS = [{ key: 'dakota', label: 'Dakota' }]

describe('calendar trail lines in words', () => {
  it('names the rep, formats the call-back time and the visit outcome', () => {
    expect(calendarTrailText('Calendar hold placed (dakota)', REPS)).toBe('Calendar hold placed with Dakota')
    expect(calendarTrailText('Calendar hold placed (ana)', REPS)).toBe('Calendar hold placed with Ana')
    // 21:30 UTC = 2:30 PM Pacific.
    expect(calendarTrailText('Call back due 2026-10-13T21:30:00.000Z', REPS)).toBe('Call back due Oct 13, 2:30 PM')
    expect(calendarTrailText('Calendar visit: no-show', REPS)).toBe('Visit: no-show')
    expect(calendarTrailText('Calendar visit: sat', REPS)).toBe('Visit happened (sat)')
  })

  it('leaves everything else alone', () => {
    expect(calendarTrailText('Calendar visit: constructor', REPS)).toBeNull()
    expect(calendarTrailText('Call back due tomorrow', REPS)).toBeNull()
    expect(calendarTrailText('Wants the visit after school pickup', REPS)).toBeNull()
  })

  it("keeps the calendar's own lines out of Today's note snippet", () => {
    const lead = seedLeads()[0]
    const at = '2026-10-12T18:00:00.000Z'
    const withNotes: CallLead = {
      ...lead,
      trail: [
        ...lead.trail,
        { kind: 'note', at, label: 'Note', detail: 'Wife decides; call after 5' },
        { kind: 'note', at, label: 'Note', detail: 'Calendar hold placed with Dakota' },
      ],
    }
    expect(noteSnippet(withNotes)).toBe('Wife decides; call after 5')
  })
})
