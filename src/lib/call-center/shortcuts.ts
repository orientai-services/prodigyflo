/**
 * Desk keyboard shortcuts. Pure: the key → action map and the "is the rep
 * typing" test, so both are unit-tested and the component only wires them.
 */

export type DeskKeyAction =
  | { kind: 'next' }
  | { kind: 'prev' }
  | { kind: 'call' }
  | { kind: 'take' }
  | { kind: 'outcome'; index: number }
  | { kind: 'note' }
  | { kind: 'search' }
  | { kind: 'power' }
  | { kind: 'pause' }
  | { kind: 'help' }
  | { kind: 'close' }

export const SHORTCUTS: { keys: string; what: string }[] = [
  { keys: 'J / K', what: 'Next / previous lead' },
  { keys: 'C', what: 'Call the open lead' },
  { keys: 'T', what: 'Take the open lead' },
  { keys: '1–9', what: 'Record a result, in the order of the Result buttons' },
  { keys: 'N', what: 'Write a note' },
  { keys: '/', what: 'Search leads' },
  { keys: 'P', what: 'Power mode on or off' },
  { keys: 'Space', what: 'Pause or carry on the power countdown' },
  { keys: '?', what: 'Show this list' },
]

export type KeyLike = { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }

export function deskKeyAction(event: KeyLike): DeskKeyAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  const key = event.key
  if (key === '?') return { kind: 'help' }
  if (key === 'Escape') return { kind: 'close' }
  if (key === '/') return { kind: 'search' }
  if (key === ' ' || key === 'Spacebar') return { kind: 'pause' }
  if (/^[1-9]$/.test(key)) return { kind: 'outcome', index: Number(key) - 1 }
  switch (key.toLowerCase()) {
    case 'j': return { kind: 'next' }
    case 'k': return { kind: 'prev' }
    case 'c': return { kind: 'call' }
    case 't': return { kind: 'take' }
    case 'n': return { kind: 'note' }
    case 'p': return { kind: 'power' }
    default: return null
  }
}

export type FocusLike = {
  tagName?: string
  isContentEditable?: boolean
  getAttribute?: (name: string) => string | null
} | null | undefined

const TYPING_INPUTS = new Set(['text', 'search', 'email', 'tel', 'url', 'number', 'password', 'date', 'datetime-local', 'time', ''])

/** Focus is in something the rep types into: shortcuts stay out of the way. */
export function isTypingTarget(el: FocusLike): boolean {
  if (!el || !el.tagName) return false
  const tag = el.tagName.toUpperCase()
  if (el.isContentEditable) return true
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return TYPING_INPUTS.has((el.getAttribute?.('type') ?? '').toLowerCase())
  return el.getAttribute?.('role') === 'textbox'
}
