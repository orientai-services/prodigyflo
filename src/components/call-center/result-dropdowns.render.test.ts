import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, prefetch: () => {} }),
}))

const { CallCenter } = await import('./call-center')
const { WrapUp } = await import('./power-panel')
const { VisitPanel } = await import('./calendar/visit-panel')
const { MissedCalls } = await import('@/components/telephony/missed-calls')
const { OUTCOMES, OUTCOME_GROUPS, seedLeads } = await import('@/lib/call-center/model')
const { outcomeGroups } = await import('./outcome-choices')
const { MISSED_DISPOSITIONS } = await import('@/lib/telephony/voice-contract')
const { DISPOSITION_GROUPS } = await import('@/components/telephony/missed-calls')

const AT = '2026-09-28T18:30:00.000Z'

/** The <option> texts inside one <optgroup label="…">, in order. */
function groupOptions(html: string, label: string): string[] {
  const match = html.match(new RegExp(`<optgroup label="${label}">(.*?)</optgroup>`))
  if (!match) return []
  return [...match[1].matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1])
}

// docs/DIALER_APP.md: every result is one native dropdown, never a row of buttons.
describe('result dropdowns', () => {
  it('groups every lead outcome exactly once and keeps the shortcut order', () => {
    const ids = OUTCOME_GROUPS.flatMap((group) => group.ids)
    expect([...ids].sort()).toEqual(OUTCOMES.map((item) => item.id).sort())
    expect(new Set(ids).size).toBe(OUTCOMES.length)
    // The 1–9 keys follow OUTCOMES, so the numbers shown must too.
    const keyed = outcomeGroups({ keys: true }).flatMap((group) => group.options)
    for (const option of keyed) {
      const index = OUTCOMES.findIndex((item) => item.id === option.value)
      expect(option.label).toBe(`${OUTCOMES[index].label} (${index + 1})`)
    }
  })

  it('shows the lead panel result as one select with a placeholder and three groups', () => {
    const html = renderToString(
      createElement(CallCenter, {
        initialLeads: seedLeads(),
        viewerId: '',
        renderedAt: AT,
        route: { section: 'leads', ads: false, filter: null },
        phone: { openLeadId: 'owen-briggs' },
      }),
    )
    expect(html).toMatch(/<select aria-label="Result for Owen Briggs"/)
    expect(html).toContain('<option value="" disabled="" selected="">Choose an outcome…</option>')
    expect(groupOptions(html, 'Reached')).toEqual(['Talked', 'Callback', 'Appointment'])
    expect(groupOptions(html, 'Didn’t reach')).toEqual(['Voicemail', 'No answer', 'Busy'])
    expect(groupOptions(html, 'Close out')).toEqual(['Wrong number', 'Not interested', 'Do not call'])
    // No result buttons are left in the Result section.
    const result = html.slice(html.indexOf('<h3>Result</h3>'), html.indexOf('<h3>Handoff</h3>'))
    expect(result).not.toContain('<button')
  })

  it('shows the wrap-up result as a select with the shortcut keys and the suggestion', () => {
    const lead = seedLeads()[0]
    const html = renderToString(
      createElement(WrapUp, {
        lead,
        call: { seq: 1, target: `lead:${lead.id}`, direction: 'outbound', who: lead.name, answered: false, talkSeconds: 0, endedAt: 0, error: null },
        required: true,
        busy: false,
        error: null,
        scheduler: null,
        onOutcome: () => {},
        onLater: () => {},
      }),
    )
    expect(html).toContain(`aria-label="Result for the call with ${lead.name}"`)
    expect(groupOptions(html, 'Reached')).toEqual(['Talked (1)', 'Callback (7)', 'Appointment (8)'])
    expect(groupOptions(html, 'Didn’t reach')).toEqual(['Voicemail (2)', 'No answer (3) · suggested', 'Busy (4)'])
    // Power mode requires a result: no Later.
    expect(html).not.toContain('>Later<')
  })

  it('closes a missed call from one select holding every disposition', () => {
    const values = DISPOSITION_GROUPS.flatMap((group) => group.options.map((option) => option.value))
    expect([...values].sort()).toEqual([...MISSED_DISPOSITIONS].sort())
    const html = renderToString(
      createElement(MissedCalls, {
        calls: [{ id: 'm1', at: AT, lineLabel: 'Main', caller: 'Ana Ruiz', target: null, reason: 'no-answer', voicemail: null }],
      }),
    )
    expect(html).toContain('aria-label="Close the call from Ana Ruiz as"')
    expect(groupOptions(html, 'Dealt with')).toEqual(['Called back', 'Handled'])
    expect(groupOptions(html, 'Not reached')).toEqual(['No answer'])
    expect(groupOptions(html, 'Not a real call')).toEqual(['Spam', 'Wrong number'])
    expect(html).toContain('>Add note<')
  })

  it('offers Sat and No-show only on a confirmed visit', () => {
    const visit = {
      id: 'v1', leadId: 'l1', name: 'Ana Ruiz', last4: null, language: 'EN' as const, repKey: 'r', startsAt: AT, endsAt: AT,
      status: 'CONFIRMED' as const, note: null,
    }
    const rep = { key: 'r', label: 'Rep', color: 'teal' } as Parameters<typeof VisitPanel>[0]['rep']
    const props = { rep, onClose: () => {}, onReschedule: () => {}, onChanged: () => {} }
    const confirmed = renderToString(createElement(VisitPanel, { ...props, visit }))
    expect(confirmed).toContain('aria-label="Outcome of the visit with Ana Ruiz"')
    expect(groupOptions(confirmed, 'Happened')).toEqual(['Sat'])
    expect(groupOptions(confirmed, 'Didn’t happen')).toEqual(['No-show', 'Rescheduled', 'Cancel visit'])
    expect(confirmed).not.toContain('Yes, cancel it')
    const hold = renderToString(createElement(VisitPanel, { ...props, visit: { ...visit, status: 'HOLD' as const } }))
    expect(hold).not.toContain('label="Happened"')
    expect(groupOptions(hold, 'Didn’t happen')).toEqual(['Rescheduled', 'Cancel visit'])
  })
})
