import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, prefetch: () => {} }),
}))

const { CallCenter } = await import('./call-center')
const { seedLeads } = await import('@/lib/call-center/model')
const { MessagesSwitch, Badge } = await import('./messages/chat/team-chat-section')

const AT = '2026-09-28T18:30:00.000Z'

// The team chat counts stream in after the page (page.tsx teamChatCountsOnce): the first paint must not wait for
// them, and the lead-text count the server already has shows straight away.
describe('Team chat counts streamed beside the page', () => {
  const messagesTab = (html: string) => html.match(/href="\/call-center\?s=messages"[^]*?<\/a>/)?.[0] ?? ''

  it('renders the dialer with the chat answer still pending, the Messages badge showing the lead texts', () => {
    const pending = new Promise<{ total: number; cases: Record<string, number> }>(() => {})
    const html = renderToString(
      createElement(CallCenter, { initialLeads: seedLeads(), viewerId: '', renderedAt: AT, unread: 3, unreadSplit: { sms: 3, team: 0, teamChat: pending } }),
    )
    expect(messagesTab(html)).toContain('>3<')
  })

  it('draws the same badge as before when no stream is passed', () => {
    const html = renderToString(
      createElement(CallCenter, { initialLeads: seedLeads(), viewerId: '', renderedAt: AT, unread: 5, unreadSplit: { sms: 3, team: 2 } }),
    )
    expect(messagesTab(html)).toContain('>5<')
  })

  it('the Messages switch takes a streamed Team chat badge in place of the number', () => {
    const streamed = renderToString(
      createElement(MessagesSwitch, { base: '/call-center?s=messages', view: 'sms', teamUnread: 0, teamBadge: createElement(Badge, { n: 4 }), smsUnread: 0 }),
    )
    const plain = renderToString(createElement(MessagesSwitch, { base: '/call-center?s=messages', view: 'sms', teamUnread: 4, smsUnread: 0 }))
    expect(streamed).toBe(plain)
  })
})
