import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CommsTrail } from './comms-trail'
import type { TrailEvent } from '@/lib/call-center/model'

function call(n: number): TrailEvent {
  const at = new Date(Date.UTC(2026, 9, 1, 15, n)).toISOString()
  return { kind: 'call', at, label: `Call ${n}`, detail: 'Answered', recording: { src: `/api/voice/recordings/r${n}`, seconds: 30 + n } }
}

describe('CommsTrail', () => {
  it('shows only the newest three recordings and a Show more with the hidden count', () => {
    const trail: TrailEvent[] = [
      { kind: 'form', at: '2026-10-01T14:00:00.000Z', label: 'Facebook form', detail: 'Form received' },
      ...Array.from({ length: 15 }, (_, n) => call(n)),
    ]
    const html = renderToString(createElement(CommsTrail, { trail }))
    expect(html.match(/<audio /g)?.length).toBe(3)
    for (const n of [12, 13, 14]) expect(html).toContain(`/api/voice/recordings/r${n}"`)
    expect(html).not.toContain('/api/voice/recordings/r11"')
    expect(html).not.toContain('Facebook form')
    expect(html).toMatch(/<button type="button" class="linkish" aria-controls="[^"]+" aria-label="Show 10 more of 12 earlier recordings">Show more \(<!-- -->12<!-- -->\)<\/button>/)
    expect(html).not.toContain('Show less')
  })

  it('shows a short trail whole, with no toggle', () => {
    const trail = [call(1), { kind: 'note', at: '2026-10-01T15:30:00.000Z', label: 'Note', detail: 'Ok' } as TrailEvent, call(2)]
    const html = renderToString(createElement(CommsTrail, { trail }))
    expect(html.match(/<audio /g)?.length).toBe(2)
    expect(html).toContain('>Note<')
    expect(html).not.toContain('Show more')
  })
})
