import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import * as Lucide from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { iconByName } from './icon-by-name'

const SRC = path.resolve(__dirname, '..')

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) files(full, out)
    else if (full.endsWith('.tsx')) out.push(full)
  }
  return out
}

/** Every name a caller can hand to the named-icon lookup. */
function usedNames(): string[] {
  const names = new Set<string>(['Inbox'])
  const nav = readFileSync(path.join(SRC, 'lib/navigation.ts'), 'utf8')
  for (const m of nav.matchAll(/icon: '([A-Za-z0-9]+)'/g)) names.add(m[1])
  for (const file of files(SRC)) {
    const text = readFileSync(file, 'utf8')
    for (const tag of text.matchAll(/<EmptyState\b([\s\S]*?)\/?>/g)) {
      const icon = /icon=(?:"([^"]*)"|\{([^}]*)\})/.exec(tag[1])
      if (!icon) continue
      // A computed name would escape this check: keep EmptyState icons literal.
      expect(icon[1], `${path.relative(SRC, file)} passes a computed EmptyState icon`).toBeDefined()
      names.add(icon[1])
    }
  }
  return [...names].sort()
}

describe('iconByName', () => {
  it('resolves every used name exactly as the whole lucide namespace did', () => {
    const all = Lucide as unknown as Record<string, unknown>
    const names = usedNames()
    expect(names.length).toBeGreaterThan(40)
    for (const name of names) expect(iconByName(name), name).toBe(all[name])
  })

  it('answers undefined for unknown names and object keys', () => {
    expect(iconByName('NoSuchIcon')).toBeUndefined()
    expect(iconByName('constructor')).toBeUndefined()
    expect(iconByName('toString')).toBeUndefined()
  })
})
