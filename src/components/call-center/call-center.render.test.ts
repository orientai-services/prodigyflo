import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, prefetch: () => {} }),
}))

const { CallCenter } = await import('./call-center')
const { seedLeads } = await import('@/lib/call-center/model')

const AT = '2026-09-28T18:30:00.000Z'

// A server render of the whole dialer: the seed/preview path must keep working
// (no voice provider, no saved leads), and Today is the default section.
describe('Call Center dialer render', () => {
  it('opens on Today with the header, the six sections and the attack list', () => {
    const html = renderToString(createElement(CallCenter, { initialLeads: seedLeads(), viewerId: '', renderedAt: AT }))
    // No voice provider: the phone pill is red, and no preview banner or header note.
    expect(html).toMatch(/class="phone-pill red"[^>]*aria-label="Phone off. Phone settings and test."/)
    expect(html).not.toContain('Preview. Twilio is not connected.')
    expect(html).not.toContain('Voice not connected')
    expect(html).toContain('<h1 class="cc-title">Today</h1>')
    expect(html).toMatch(/class="cc-dialer"[^>]*>.*Dialer<\/span>/)
    for (const label of ['Today', 'Messages', 'Leads', 'Booked', 'History', 'More']) {
      expect(html).toContain(`<span class="cc-tab-label">${label}</span>`)
    }
    expect(html).toContain('<a class="on" aria-current="page" href="/call-center?s=today">')
    // Today: the date in Pacific time, the four tiles as links, the explainer, the list and the feed.
    expect(html).toContain('Monday, September 28')
    expect(html).toContain('href="/call-center?s=leads&amp;f=uncontacted"')
    expect(html).toContain('href="/call-center?s=leads&amp;f=due"')
    expect(html).toContain('Follow-ups today')
    expect(html).toContain('Confirmed today')
    expect(html).toContain('This is your call list for the day.')
    expect(html).toContain('What to attack first')
    expect(html).toContain('updates by itself')
    expect(html).toContain('Mara Ellison')
    expect(html).toContain('Team activity today')
    // Power mode needs browser calling.
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Power mode <!-- -->off/)
    // The Today badge counts not contacted + follow-ups due.
    expect(html).toMatch(/class="cc-badge"[^>]*>\d+</)
  })

  it('opens a lead from ?lead= on Leads with the filters', () => {
    const html = renderToString(
      createElement(CallCenter, {
        initialLeads: seedLeads(),
        viewerId: '',
        renderedAt: AT,
        route: { section: 'leads', ads: false, filter: null },
        phone: { openLeadId: 'owen-briggs' },
      }),
    )
    expect(html).toContain('<h1 class="cc-title">Leads</h1>')
    expect(html).toContain('<h2 class="who">Owen Briggs</h2>')
    expect(html).toContain('aria-label="Search leads"')
    expect(html).toMatch(/aria-selected="true"[^>]*>All</)
    expect(html).toContain('>Follow-ups<')
  })

  it('renders a server slot for History and the Team list for Team', () => {
    const history = renderToString(
      createElement(CallCenter, {
        initialLeads: seedLeads(),
        renderedAt: AT,
        route: { section: 'history', ads: false, filter: null },
        slot: createElement('p', null, 'history slot'),
      }),
    )
    expect(history).toContain('<h1 class="cc-title">History</h1>')
    expect(history).toContain('history slot')
    expect(history).not.toContain('What to attack first')
    expect(history).not.toContain('aria-label="Search leads"')

    const team = renderToString(
      createElement(CallCenter, {
        initialLeads: seedLeads(),
        renderedAt: AT,
        route: { section: 'team', ads: false, filter: null },
        team: [{ id: 'u1', name: 'Gatsby Rep', role: 'Closer', ready: true, calls: 3, talkSeconds: 134, booked: 1, lastAt: AT }],
      }),
    )
    expect(team).toContain('<h1 class="cc-title">Team</h1>')
    expect(team).toContain('Gatsby Rep')
    expect(team).toContain('presence ready')
    expect(team).toContain('2:14')
    // More reads as the current tab while Team is open.
    expect(team).toMatch(/aria-current="page"[^>]*data-more-toggle/)
  })

  it('hides the tab bar while a Messages thread fills the phone', () => {
    const html = renderToString(
      createElement(CallCenter, {
        initialLeads: seedLeads(),
        renderedAt: AT,
        route: { section: 'messages', ads: false, filter: null },
        threadOpen: true,
        unread: 3,
      }),
    )
    expect(html).toMatch(/class="final-desk call-center s-messages[^"]*thread-open/)
    expect(html).toContain('3 unread')
  })
})
