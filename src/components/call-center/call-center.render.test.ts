import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, prefetch: () => {} }),
}))

const { CallCenter } = await import('./call-center')
const { seedLeads } = await import('@/lib/call-center/model')

// A server render of the whole desk: the seed/preview path must keep working
// (no voice provider, no saved leads), and Today is the default tab.
describe('Call Center desk render', () => {
  it('opens on Today with the seed leads', () => {
    const html = renderToString(
      createElement(CallCenter, { initialLeads: seedLeads(), viewerId: '', renderedAt: '2026-09-28T18:30:00.000Z' }),
    )
    expect(html).toContain('Preview. Twilio is not connected.')
    expect(html).toContain('New not contacted')
    expect(html).toContain('Call first')
    expect(html).toContain('Callbacks requested / missed')
    expect(html).toContain('Going cold')
    // Oldest new lead first among those the rep can call (Chris Hale is held by Sam).
    expect(html.indexOf('Mara Ellison')).toBeGreaterThan(-1)
    expect(html).toMatch(/aria-selected="true"[^>]*>Today</)
    // Power mode needs browser calling.
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Power mode <!-- -->off/)
  })

  it('opens a lead from ?lead= on the Today tab', () => {
    const html = renderToString(
      createElement(CallCenter, {
        initialLeads: seedLeads(),
        viewerId: '',
        renderedAt: '2026-09-28T18:30:00.000Z',
        phone: { openLeadId: 'owen-briggs' },
      }),
    )
    expect(html).toContain('<h2 class="who">Owen Briggs</h2>')
  })
})
