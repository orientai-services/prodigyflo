import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Source-level guards: these client effects are not mounted in the node suite.
describe('desk performance safeguards', () => {
  const ui = readFileSync('src/components/final-desk/final-desk.tsx', 'utf8')
  const data = readFileSync('src/lib/final-desk/data.ts', 'utf8')
  it('skips background polls while hidden or a refresh is pending', () => {
    expect(ui).toContain("document.visibilityState === 'visible' && !refreshPending.current && !busyRef.current")
  })
  it('releases the pending counter even when refresh fails', () => {
    expect(ui).toContain('refreshPending.current++\n    try {')
    expect(ui).toContain('} finally {\n      refreshPending.current--')
  })
  it('starts independent board and filtered-client reads alongside queue loading', () => {
    expect(data).toContain('const [clients, board, filteredClients] = await Promise.all([')
    expect(data).toContain("view === 'board' ? loadDeskBoard(user, month)")
    expect(data).toContain("view === 'clients' ? loadFilteredClients(user, query)")
    expect(data).toContain('const queueCount = clients.filter(')
  })
})
