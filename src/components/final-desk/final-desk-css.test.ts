import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(path.join(process.cwd(), 'src/components/final-desk/final-desk.css'), 'utf8')

describe('final-desk.css reset', () => {
  // The reset's :not() list gives it (0,2,0), more than `.final-desk td` (0,1,1):
  // without th/td in that list every desk table (Clients, Queue, the Call Center
  // lead list on a desk) loses its cell padding.
  it('leaves table cells to the table rules', () => {
    const reset = css.match(/\.final-desk \*:not\(([^)]*)\)\{[^}]*padding:0/)
    expect(reset).not.toBeNull()
    const excluded = reset![1].split(',').map((s) => s.trim())
    expect(excluded).toEqual(expect.arrayContaining(['th', 'td']))
    expect(css).toMatch(/\.final-desk td\{padding:12px 14px/)
  })
})
