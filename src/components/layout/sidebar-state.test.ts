import { describe, expect, it } from 'vitest'
import {
  SIDEBAR_OPEN_CLASS,
  SIDEBAR_STORAGE_KEY,
  parseSidebarState,
  persistSidebarExpanded,
  readSidebarExpanded,
  sidebarStateToToken,
} from './sidebar-state'

function fakeRoot(initial: string[] = []) {
  const classes = new Set(initial)
  return {
    classes,
    classList: {
      contains: (cls: string) => classes.has(cls),
      toggle: (cls: string, force?: boolean) => {
        const next = force ?? !classes.has(cls)
        if (next) classes.add(cls)
        else classes.delete(cls)
        return next
      },
    },
  }
}

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
  }
}

describe('parseSidebarState', () => {
  it('expands only on the exact stored token', () => {
    expect(parseSidebarState('expanded')).toBe('expanded')
  })

  it.each([null, undefined, '', 'collapsed', 'EXPANDED', 'true', '1', 'open'])(
    'defaults to collapsed for %j',
    (raw) => {
      expect(parseSidebarState(raw)).toBe('collapsed')
    },
  )

  it('round-trips both tokens', () => {
    expect(parseSidebarState(sidebarStateToToken(true))).toBe('expanded')
    expect(parseSidebarState(sidebarStateToToken(false))).toBe('collapsed')
  })
})

describe('readSidebarExpanded', () => {
  it('reads the stamped class', () => {
    expect(readSidebarExpanded(fakeRoot([SIDEBAR_OPEN_CLASS]))).toBe(true)
    expect(readSidebarExpanded(fakeRoot())).toBe(false)
  })

  it('returns the collapsed default when no DOM exists (server/node)', () => {
    expect(readSidebarExpanded()).toBe(false)
  })
})

describe('persistSidebarExpanded', () => {
  it('stamps the class and stores the token on expand', () => {
    const root = fakeRoot()
    const storage = fakeStorage()
    persistSidebarExpanded(true, root, storage)
    expect(root.classes.has(SIDEBAR_OPEN_CLASS)).toBe(true)
    expect(storage.map.get(SIDEBAR_STORAGE_KEY)).toBe('expanded')
  })

  it('removes the class and stores collapsed on collapse', () => {
    const root = fakeRoot([SIDEBAR_OPEN_CLASS])
    const storage = fakeStorage()
    persistSidebarExpanded(false, root, storage)
    expect(root.classes.has(SIDEBAR_OPEN_CLASS)).toBe(false)
    expect(storage.map.get(SIDEBAR_STORAGE_KEY)).toBe('collapsed')
  })

  it('still stamps the class when storage throws', () => {
    const root = fakeRoot()
    persistSidebarExpanded(true, root, {
      setItem: () => {
        throw new Error('storage blocked')
      },
    })
    expect(root.classes.has(SIDEBAR_OPEN_CLASS)).toBe(true)
  })

  it('does not throw with no DOM at all (server/node)', () => {
    expect(() => persistSidebarExpanded(true)).not.toThrow()
  })
})
