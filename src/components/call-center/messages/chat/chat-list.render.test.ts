import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatList } from './chat-list'
import { NO_FEATURES, chatFeatures } from './format'
import { strings } from './strings'
import type { Channel, Me } from './types'

/** The conversation list (docs/TEAM_CHAT_PARITY.md B1–B4) as the server would draw it. */

const at = Date.UTC(2026, 9, 13, 17, 0, 0)
const me: Me = { uid: 'u1', name: 'Ada Admin', role: 'admin', staff: true, super: false, company_id: 1, lang: 'en' }
const chan = (o: Partial<Channel>): Channel => ({
  id: 'c_1', kind: 'group', name: 'Ops', read_only: false, can_post: true, unread: 0, mentions: 0, pins: 0, last_msg: null, last_msg_at: null,
  members: [], member_count: 3, muted: false, notify: 'all', last_read_msg_id: null, ...o,
})
const lm = (o: Partial<NonNullable<Channel['last_msg']>> = {}) => ({ id: 'm_a', uid: 'u2', name: 'Gatsby Rep', body: 'hello', at, att: null, deleted: false, ...o })
const k = { lead_id: 'pf:x', host: 'prodigyflo' as const, stage: 'Booked', closed: false, rep_uid: 'u2', rep_name: 'Gatsby Rep', phone4: null, appt_at: null, meet_uri: null, dialer_url: '/', type: null }
const channels = [
  chan({ id: 'c_dm', kind: 'dm', name: 'Gatsby Rep', dm_uid: 'u2', unread: 2, mentions: 2, last_msg: lm() }),
  chan({ id: 'c_case', kind: 'group', name: 'Ana Client', case: k, last_msg: lm({ uid: 'u1', body: 'ok', seen: 1 }), member_count: 2 }),
  chan({ id: 'c_gen', kind: 'main', name: 'general', unread: 4, muted: true, last_msg: lm({ at: at - 1000 }) }),
  chan({ id: 'c_grp', kind: 'group', name: 'Closers', unread: 1, last_msg: lm({ at: at - 2000 }) }),
]
const noop = () => undefined
const render = (o: Partial<Parameters<typeof ChatList>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(ChatList, {
      t: strings('en'), lang: 'en', me, channels, online: {}, active: null, query: '', setQuery: noop, cat: '', setCat: noop, live: 'live', net: true,
      rooms: { rooms: [], inside: 2, can_create: true, owners: [] }, searchRef: createRef<HTMLInputElement>(), syncing: false, features: NO_FEATURES,
      onRetry: noop, onOpen: noop, onNew: noop, onSearch: noop, onRooms: noop, onFlagged: noop, onAnnounce: noop, onSync: noop, onSettings: noop, ...o,
    }),
  )

describe('team chat list', () => {
  it('opens on the three categories in order with counts and unseen badges', () => {
    const html = render()
    const order = ['Direct messages', 'Clients', 'Channels'].map((l) => html.indexOf(`<span class="chat-cat-name">${l}</span>`))
    expect(order.every((i) => i > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // DMs: mentions win the badge; Channels: the muted #general adds nothing, the group adds 1.
    expect(html).toContain('aria-label="Direct messages, 1, 2 unread"')
    expect(html).toContain('<span class="chat-badge mention" aria-hidden="true">@2</span>')
    expect(html).toContain('aria-label="Channels, 2, 1 unread"')
  })

  it('shows one category under a back header, newest first, with ticks, mute and case facts', () => {
    const html = render({ cat: 'chans' })
    expect(html).toContain('aria-label="Back to categories, 4 unread elsewhere"')
    expect(html.indexOf('#general')).toBeLessThan(html.indexOf('Closers'))
    expect(html).toContain(' 🔕</small>')
    const clients = render({ cat: 'clients' })
    expect(clients).toContain('<span class="chat-tick all" aria-label="Seen by everyone">✓✓</span>Gatsby · Booked · You: ok')
  })

  it('a search shows every match plus a message search row', () => {
    const html = render({ query: 'gatsby', cat: 'chans' })
    expect(html).not.toContain('chat-catback')
    expect(html).toContain('Gatsby Rep')
    expect(html).toContain('Ana Client')
    expect(html).toContain('Search messages for “gatsby”')
  })

  it('footer: me, live state, rooms with people inside, staff tools, settings; offline banner', () => {
    const html = render({ live: 'poll', net: false, features: { rooms: true, announce: true, sync: true } })
    expect(html).toContain('<b>Ada Admin</b>')
    expect(html).toContain('Every 5 s')
    expect(html).toContain('2 inside')
    for (const l of ['Flagged', 'Announce', 'Sync now', 'Settings']) expect(html).toContain(l)
    expect(html).toContain('Offline. Retrying…')
    const rep = render({ me: { ...me, staff: false } })
    expect(rep).not.toContain('Flagged')
    expect(render({ me: null })).toContain('chat-skel')
  })

  it('ProdigyFlo scope: no Rooms, Announce or Sync now; Flagged stays for staff', () => {
    const html = render({ features: chatFeatures({ scope: 'prodigyflo', features: { rooms: false, announce: false, sync: false } }) })
    for (const l of ['Rooms', 'inside', 'Announce', 'Sync now']) expect(html).not.toContain(l)
    expect(html).toContain('Flagged')
    expect(html).toContain('Settings')
    // An older Worker that says nothing about features: the SunOff tools stay off too.
    expect(chatFeatures({})).toEqual({ rooms: false, announce: false, sync: false })
    expect(chatFeatures({ me: { features: { rooms: true } } } as never)).toEqual({ rooms: true, announce: false, sync: false })
  })

  it('every category shows, an empty one with 0, and opens to its own empty state', () => {
    const dmsOnly = [channels[0]]
    const html = render({ channels: dmsOnly })
    expect(html).toContain('aria-label="Clients, 0"')
    expect(html).toContain('aria-label="Channels, 0"')
    expect(render({ channels: dmsOnly, cat: 'clients' })).toContain('Client chats appear here when a lead is assigned to you in the Call Center.')
    expect(render({ channels: dmsOnly, cat: 'chans' })).toContain('No team conversations yet. Start one with +')
    const none = render({ channels: [] })
    expect(none).toContain('aria-label="Direct messages, 0"')
    expect(none).toContain('No team conversations yet. Start one with +')
    expect(render({ channels: [], lang: 'es', t: strings('es'), cat: 'clients' })).toContain('cuando se le asigna un prospecto en el Call Center')
  })

  it('names nothing from SunOff on screen', () => {
    for (const lang of ['en', 'es'] as const) {
      const words = JSON.stringify(Object.values(strings(lang)).filter((v) => typeof v === 'string'))
      expect(words).not.toMatch(/sunoff|dialer|marcador/i)
    }
    expect(strings('en').linkBtn).toBe('Turn on team chat')
  })
})
