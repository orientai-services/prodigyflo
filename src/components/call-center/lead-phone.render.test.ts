import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, prefetch: () => {} }),
}))

const { LeadPhone } = await import('./lead-phone')
const { CallCenter } = await import('./call-center')
const { seedLeads } = await import('@/lib/call-center/model')
type CallLead = import('@/lib/call-center/model').CallLead

const SHOWN = { state: 'shown', display: '(702) 555-0123', copy: '+17025550123' } as const
const AT = '2026-09-28T18:30:00.000Z'

function desk(patch: Partial<CallLead>, openLeadId: string | null = 'owen-briggs'): string {
  const leads = seedLeads().map((lead) => (lead.id === 'owen-briggs' ? { ...lead, ...patch } : lead))
  return renderToString(createElement(CallCenter, {
    initialLeads: leads,
    viewerId: '',
    renderedAt: AT,
    route: { section: 'leads', ads: false, filter: null },
    phone: { openLeadId },
  }))
}

// docs/DIALER_APP.md §Phone numbers.
describe('LeadPhone', () => {
  it('shows the full number as a tap-to-copy button, never a tel: link', () => {
    const html = renderToString(createElement(LeadPhone, { phone: SHOWN, last4: '0123' }))
    expect(html).toContain('(702) 555-0123')
    expect(html).toContain('<button type="button"')
    expect(html).toContain('aria-label="Copy (702) 555-0123"')
    expect(html).not.toContain('tel:')
  })

  it('is plain text when it sits inside another control', () => {
    const html = renderToString(createElement(LeadPhone, { phone: SHOWN, last4: '0123', copyable: false }))
    expect(html).toContain('(702) 555-0123')
    expect(html).not.toContain('<button')
  })

  it('says "Number unavailable" instead of dots when the number cannot be read', () => {
    const html = renderToString(createElement(LeadPhone, { phone: { state: 'unavailable' }, last4: '0123' }))
    expect(html).toContain('Number unavailable')
    expect(html).not.toContain('0123')
  })

  it('keeps the last four for a viewer without the permission', () => {
    const html = renderToString(createElement(LeadPhone, { last4: '0123' }))
    expect(html).toContain('•••-•••-0123')
    expect(html).not.toContain('<button')
  })
})

describe('desk: lead phone numbers', () => {
  it('the list row and the lead panel show the full number the server sent', () => {
    const html = desk({ last4: '0123', phone: SHOWN })
    // Row (plain text inside the row button) and panel (copy button).
    expect(html.split('(702) 555-0123').length - 1).toBeGreaterThanOrEqual(2)
    expect(html).toContain('aria-label="Copy (702) 555-0123"')
    expect(html).not.toContain('href="tel:+17025550123"')
  })

  it('without a full number the row and panel keep the last four', () => {
    const html = desk({ last4: '0123', phone: undefined })
    expect(html).not.toContain('(702) 555-0123')
    expect(html).toContain('•••-•••-0123')
  })

  it('an unreadable number reads "Number unavailable" in the panel', () => {
    const html = desk({ last4: '0123', phone: { state: 'unavailable' } })
    expect(html).toContain('Number unavailable')
  })
})
