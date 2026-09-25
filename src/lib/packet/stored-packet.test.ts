import { describe, expect, it } from 'vitest'
import { closerPacketKey } from './stored-packet'

describe('closerPacketKey', () => {
  it('builds a namespaced pdf key and rejects traversal', () => {
    expect(closerPacketKey('c'.repeat(24), 'review')).toBe(`closer-packets/${'c'.repeat(24)}/review.pdf`)
    expect(closerPacketKey('c'.repeat(24), 'pitch')).toBe(`closer-packets/${'c'.repeat(24)}/pitch.pdf`)
    expect(() => closerPacketKey('../etc/passwd', 'review')).toThrow()
    expect(() => closerPacketKey('HasUpper', 'pitch')).toThrow()
  })
})
