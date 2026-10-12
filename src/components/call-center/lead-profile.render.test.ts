import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, prefetch: () => {} }),
}))

const { CallCenter } = await import('./call-center')
const { seedLeads } = await import('@/lib/call-center/model')
type CallLead = import('@/lib/call-center/model').CallLead

const AT = '2026-09-28T18:30:00.000Z'

function panel(patch: Partial<CallLead>): string {
  const leads = seedLeads().map((lead) => (lead.id === 'owen-briggs' ? { ...lead, ...patch } : lead))
  return renderToString(createElement(CallCenter, {
    initialLeads: leads,
    viewerId: '',
    renderedAt: AT,
    route: { section: 'leads', ads: false, filter: null },
    phone: { openLeadId: 'owen-briggs' },
  }))
}

// The lead panel's Handoff group and Client profile column (docs/CYS_BRIDGE.md §B2).
describe('lead panel: hand-off and profile', () => {
  it('no intake: SCS Intake split button, lead facts and the CTA; Lead/Profile tabs for phones', () => {
    const html = panel({})
    expect(html).toContain('class="card block detail open has-profile tab-lead"')
    expect(html).toMatch(/role="tab" aria-selected="true" class="on">Lead</)
    expect(html).toMatch(/role="tab" aria-selected="false" class="">Profile</)
    expect(html).toContain('>SCS Intake<')
    expect(html).toContain('aria-label="SCS Intake options"')
    expect(html).not.toContain('Send intake link')
    expect(html).toContain('data-state="no_intake"')
    expect(html).toContain('No intake yet.')
    expect(html).toContain('Start SCS Intake')
    expect(html).not.toContain('CYS Sign up')
  })

  it('link sent: when and how, Resend / Copy', () => {
    const html = panel({ intake: { sentAt: '2026-09-28T18:00:00.000Z', mode: 'copy' } })
    expect(html).toContain('data-state="link_sent"')
    expect(html).toContain('Intake link sent 30 min ago via copied link')
    expect(html).toContain('>Resend<')
    expect(html).toContain('>Copy link<')
  })

  it('linked: the profile loads, the intake button becomes "open profile", CYS Sign up appears', () => {
    const html = panel({ clientId: 'client-1' })
    expect(html).toContain('Intake linked · open profile')
    expect(html).toContain('✍️ CYS Sign up')
    expect(html).not.toContain('>SCS Intake<')
    expect(html).toContain('aria-label="Loading profile"')
  })

  it('shows the hand-off status chip instead of the button once SunOff holds the lead', () => {
    const html = panel({ clientId: 'client-1', handoff: { status: 'STANDBY', at: AT } })
    expect(html).toContain('In SunOff · Standby')
    expect(html).toContain('cys-chip s-standby')
    expect(html).not.toContain('✍️ CYS Sign up')
  })
})
