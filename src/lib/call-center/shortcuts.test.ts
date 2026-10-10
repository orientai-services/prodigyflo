import { describe, expect, it } from 'vitest'
import { leadHref, leadIdOfTarget, leadIdParam, targetHref } from './lead-link'
import { SHORTCUTS, deskKeyAction, isTypingTarget } from './shortcuts'

describe('desk shortcuts', () => {
  it('maps the keys', () => {
    expect(deskKeyAction({ key: 'j' })).toEqual({ kind: 'next' })
    expect(deskKeyAction({ key: 'J' })).toEqual({ kind: 'next' })
    expect(deskKeyAction({ key: 'k' })).toEqual({ kind: 'prev' })
    expect(deskKeyAction({ key: 'c' })).toEqual({ kind: 'call' })
    expect(deskKeyAction({ key: 't' })).toEqual({ kind: 'take' })
    expect(deskKeyAction({ key: '1' })).toEqual({ kind: 'outcome', index: 0 })
    expect(deskKeyAction({ key: '9' })).toEqual({ kind: 'outcome', index: 8 })
    expect(deskKeyAction({ key: '0' })).toBeNull()
    expect(deskKeyAction({ key: 'n' })).toEqual({ kind: 'note' })
    expect(deskKeyAction({ key: '/' })).toEqual({ kind: 'search' })
    expect(deskKeyAction({ key: 'p' })).toEqual({ kind: 'power' })
    expect(deskKeyAction({ key: ' ' })).toEqual({ kind: 'pause' })
    expect(deskKeyAction({ key: '?' })).toEqual({ kind: 'help' })
    expect(deskKeyAction({ key: 'Escape' })).toEqual({ kind: 'close' })
    expect(deskKeyAction({ key: 'x' })).toBeNull()
  })

  it('leaves browser shortcuts alone', () => {
    expect(deskKeyAction({ key: 'c', ctrlKey: true })).toBeNull()
    expect(deskKeyAction({ key: 'k', metaKey: true })).toBeNull()
    expect(deskKeyAction({ key: '1', altKey: true })).toBeNull()
  })

  it('knows when the rep is typing', () => {
    const el = (tagName: string, attrs: Record<string, string> = {}, isContentEditable = false) => ({
      tagName,
      isContentEditable,
      getAttribute: (name: string) => attrs[name] ?? null,
    })
    expect(isTypingTarget(el('TEXTAREA'))).toBe(true)
    expect(isTypingTarget(el('SELECT'))).toBe(true)
    expect(isTypingTarget(el('INPUT'))).toBe(true)
    expect(isTypingTarget(el('INPUT', { type: 'search' }))).toBe(true)
    expect(isTypingTarget(el('INPUT', { type: 'checkbox' }))).toBe(false)
    expect(isTypingTarget(el('DIV', {}, true))).toBe(true)
    expect(isTypingTarget(el('DIV', { role: 'textbox' }))).toBe(true)
    expect(isTypingTarget(el('BUTTON'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })

  it('lists every shortcut for the ? sheet', () => {
    expect(SHORTCUTS.map((row) => row.keys)).toEqual(['J / K', 'C', 'T', '1–9', 'N', '/', 'P', 'Space', '?'])
  })
})

describe('links into the desk', () => {
  it('accepts Meta lead ids in ?lead=', () => {
    expect(leadIdParam('meta:org_1:lg-123')).toBe('meta:org_1:lg-123')
    expect(leadIdParam(['cmabc123', 'x'])).toBe('cmabc123')
    expect(leadIdParam('bad id')).toBeNull()
    expect(leadIdParam('<script>')).toBeNull()
    expect(leadIdParam('x'.repeat(201))).toBeNull()
    expect(leadIdParam(undefined)).toBeNull()
  })

  it('links the ringing banner to the right record', () => {
    expect(targetHref('lead:meta:org_1:lg-123')).toBe('/call-center?lead=meta%3Aorg_1%3Alg-123')
    expect(targetHref('client:cmabc')).toBe('/clients/cmabc')
    expect(targetHref('missed:vc1')).toBeNull()
    expect(targetHref('lead:bad id')).toBeNull()
    expect(targetHref('')).toBeNull()
    expect(leadHref('cm1')).toBe('/call-center?lead=cm1')
    expect(leadIdOfTarget('lead:meta:o:l')).toBe('meta:o:l')
    expect(leadIdOfTarget('client:c1')).toBeNull()
    expect(leadIdOfTarget(null)).toBeNull()
  })
})
