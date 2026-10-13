'use client'

import { useRef, useState } from 'react'

export type ChoiceOption<T extends string> = { value: T; label: string }
export type ChoiceGroup<T extends string> = { label: string; options: ChoiceOption<T>[] }

/** Keys that move a closed native select to another option without opening it. */
const MOVE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])

/**
 * One native dropdown that stands in for a row of result buttons (the SunOff
 * dialer's "Resultado" select): a placeholder, the choices in <optgroup>s,
 * and picking one acts at once, exactly like pressing that button did.
 *
 * Keyboard: Chrome and Firefox change a closed select's value on arrow keys
 * and type-ahead, which would save a result while the rep is only browsing.
 * A choice reached that way is held and shown, and Enter saves it; picking
 * from the opened list (mouse, touch, or Enter inside it) saves straight away.
 * The select always returns to its placeholder afterwards.
 */
export function ChoiceSelect<T extends string>({
  groups,
  placeholder,
  label,
  disabled = false,
  onChoose,
  className,
}: {
  groups: ChoiceGroup<T>[]
  placeholder: string
  /** The accessible name, e.g. "Result for the call with Mara Ellison". */
  label: string
  disabled?: boolean
  onChoose: (value: T) => void
  className?: string
}) {
  const [held, setHeld] = useState<T | ''>('')
  const moved = useRef(false)
  const shown = groups.filter((group) => group.options.length > 0)
  const heldLabel = held ? shown.flatMap((group) => group.options).find((option) => option.value === held)?.label : null

  function choose(value: T) {
    setHeld('')
    onChoose(value)
  }

  return (
    <span className={`choice${className ? ` ${className}` : ''}`}>
      <select
        aria-label={label}
        value={held}
        disabled={disabled}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            if (held) {
              event.preventDefault()
              choose(held)
            }
            return
          }
          if (event.key === 'Escape' && held) {
            setHeld('')
            return
          }
          const typed = event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey
          if (MOVE_KEYS.has(event.key) || typed) {
            moved.current = true
            setTimeout(() => { moved.current = false }, 0)
          }
        }}
        onChange={(event) => {
          const value = event.target.value as T | ''
          if (!value) return
          if (moved.current) {
            setHeld(value)
            return
          }
          choose(value)
        }}
        onBlur={() => setHeld('')}
      >
        <option value="" disabled>{placeholder}</option>
        {shown.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.options.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </optgroup>
        ))}
      </select>
      {heldLabel ? (
        <small className="choice-hint" role="status">Press Enter to save {heldLabel}.</small>
      ) : null}
    </span>
  )
}
