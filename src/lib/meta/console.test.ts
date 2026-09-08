import { describe, expect, it } from 'vitest'
import { parseConsoleCommand, tokenize } from './console'

describe('tokenize', () => {
  it('splits on whitespace and honors double quotes', () => {
    expect(tokenize('budget camp-1 50')).toEqual(['budget', 'camp-1', '50'])
    expect(tokenize('create-account "Solar Exit LV" USD 1')).toEqual([
      'create-account',
      'Solar Exit LV',
      'USD',
      '1',
    ])
    expect(tokenize('  ')).toEqual([])
  })
})

describe('parseConsoleCommand', () => {
  it('parses bare commands case-insensitively', () => {
    expect(parseConsoleCommand('help')).toEqual({ ok: true, command: { kind: 'help' } })
    expect(parseConsoleCommand('LIST')).toEqual({ ok: true, command: { kind: 'list' } })
    expect(parseConsoleCommand('ls')).toEqual({ ok: true, command: { kind: 'list' } })
  })

  it('parses spend with a default and a bounded day count', () => {
    expect(parseConsoleCommand('spend')).toEqual({ ok: true, command: { kind: 'spend', days: 7 } })
    expect(parseConsoleCommand('spend 30')).toEqual({ ok: true, command: { kind: 'spend', days: 30 } })
    expect(parseConsoleCommand('spend 0').ok).toBe(false)
    expect(parseConsoleCommand('spend 91').ok).toBe(false)
    expect(parseConsoleCommand('spend soon').ok).toBe(false)
  })

  it('parses pause/resume into status commands', () => {
    expect(parseConsoleCommand('pause camp-123')).toEqual({
      ok: true,
      command: { kind: 'status', ref: 'camp-123', status: 'PAUSED' },
    })
    expect(parseConsoleCommand('resume Vegas Retargeting')).toEqual({
      ok: true,
      command: { kind: 'status', ref: 'Vegas Retargeting', status: 'ACTIVE' },
    })
    expect(parseConsoleCommand('pause').ok).toBe(false)
  })

  it('parses budget with a trailing dollar amount and a multi-word ref', () => {
    expect(parseConsoleCommand('budget camp-1 $75')).toEqual({
      ok: true,
      command: { kind: 'budget', ref: 'camp-1', usd: 75 },
    })
    expect(parseConsoleCommand('budget Solar Exit LV 1,250.50')).toEqual({
      ok: true,
      command: { kind: 'budget', ref: 'Solar Exit LV', usd: 1250.5 },
    })
    expect(parseConsoleCommand('budget camp-1').ok).toBe(false)
    expect(parseConsoleCommand('budget camp-1 free').ok).toBe(false)
  })

  it('parses cap as its own command (lifetime, not daily)', () => {
    expect(parseConsoleCommand('cap camp-1 500')).toEqual({
      ok: true,
      command: { kind: 'cap', ref: 'camp-1', usd: 500 },
    })
    // The $100 floor is enforced at dispatch (spendCapToCents), not by the parser.
    expect(parseConsoleCommand('cap camp-1 50')).toEqual({
      ok: true,
      command: { kind: 'cap', ref: 'camp-1', usd: 50 },
    })
    expect(parseConsoleCommand('cap camp-1').ok).toBe(false)
  })

  it('parses create-account with defaults and quoted names', () => {
    expect(parseConsoleCommand('create-account "Solar Exit LV"')).toEqual({
      ok: true,
      command: { kind: 'create-account', name: 'Solar Exit LV', currency: 'USD', timezone: '1' },
    })
    expect(parseConsoleCommand('create-account Roofing eur 7')).toEqual({
      ok: true,
      command: { kind: 'create-account', name: 'Roofing', currency: 'EUR', timezone: '7' },
    })
    expect(parseConsoleCommand('create-account').ok).toBe(false)
  })

  it('rejects the unknown and the empty with a pointer to help', () => {
    const unknown = parseConsoleCommand('yeet camp-1')
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error).toMatch(/help/)
    expect(parseConsoleCommand('   ').ok).toBe(false)
  })
})
