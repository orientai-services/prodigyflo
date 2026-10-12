import { describe, expect, it } from 'vitest'
import { parseTargetKey, targetKey } from './targets'

/** Dial target keys, including the dial pad's `number:` (docs/DIAL_PAD.md §2). */

describe('parseTargetKey', () => {
  it('reads the id targets', () => {
    expect(parseTargetKey('client:abc123')).toEqual({ kind: 'client', id: 'abc123' })
    expect(parseTargetKey('lead:meta:org:42')).toEqual({ kind: 'lead', id: 'meta:org:42' })
    expect(parseTargetKey(' missed:vc_1 ')).toEqual({ kind: 'missed', id: 'vc_1' })
  })

  it('accepts a hand-dialed number only as +1 and ten digits', () => {
    expect(parseTargetKey('number:+17255551234')).toEqual({ kind: 'number', id: '+17255551234' })
    for (const bad of [
      'number:7255551234',
      'number:17255551234',
      'number:+1725555123',
      'number:+172555512345',
      'number:+447911123456',
      'number:+1 725 555 1234',
      'number:+1725555123x',
      'client:+17255551234',
      'number:',
    ]) {
      expect(parseTargetKey(bad)).toBeNull()
    }
  })

  it('round-trips with targetKey', () => {
    expect(targetKey({ kind: 'number', id: '+17255551234' })).toBe('number:+17255551234')
    expect(parseTargetKey(targetKey({ kind: 'number', id: '+17255551234' }))).toEqual({ kind: 'number', id: '+17255551234' })
  })
})
