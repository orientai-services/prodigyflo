'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import { Delete, X } from 'lucide-react'
import { isTypingTarget } from '@/lib/call-center/shortcuts'
import {
  cleanTyped,
  dialableE164,
  formatAsTyped,
  formatDialed,
  maskDialed,
  pushRecent,
  readRecent,
} from '@/lib/telephony/ui/dial-pad'
import { CallButton } from '@/components/voice/call-button'

const KEYS: { key: string; sub: string }[] = [
  { key: '1', sub: '' },
  { key: '2', sub: 'ABC' },
  { key: '3', sub: 'DEF' },
  { key: '4', sub: 'GHI' },
  { key: '5', sub: 'JKL' },
  { key: '6', sub: 'MNO' },
  { key: '7', sub: 'PQRS' },
  { key: '8', sub: 'TUV' },
  { key: '9', sub: 'WXYZ' },
  { key: '*', sub: '' },
  { key: '0', sub: '+' },
  { key: '#', sub: '' },
]

/** This browser only: the last five hand-dialed numbers. */
const RECENT_KEY = 'pf.dialpad.recent'

function loadRecent(): string[] {
  try {
    return readRecent(window.localStorage.getItem(RECENT_KEY))
  } catch {
    return []
  }
}

function saveRecent(list: string[]) {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch {
    // A private window without storage just has no recent list.
  }
}

/**
 * The Call Center's hand-dial keypad (docs/DIAL_PAD.md). Call runs the same
 * server check as a lead's Call (CallButton → checkDial → the voice provider,
 * or the tel: link when browser calling is off) with target
 * `number:+1XXXXXXXXXX`; the server matches the number to a client or lead
 * and decides do-not-call and hours. A popover on a desk, a bottom sheet on
 * a phone (the parent picks where it mounts).
 */
export function DialPad({
  canOverrideHours = false,
  disabled = false,
  ignore,
  onClose,
}: {
  canOverrideHours?: boolean
  /** Power mode is waiting on a result: no new dial. */
  disabled?: boolean
  /** The button that opened the pad: a press on it is not an outside click. */
  ignore?: RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const [typed, setTyped] = useState('')
  const [recent, setRecent] = useState<string[]>(loadRecent)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const callRef = useRef<HTMLDivElement>(null)
  const e164 = dialableE164(typed)

  const press = (key: string) => setTyped((now) => cleanTyped(now + key))
  const back = () => setTyped((now) => now.slice(0, -1))
  const pressCall = () => {
    const button = callRef.current?.querySelector('button')
    if (button && !button.disabled) button.click()
  }

  // Latest handlers for the document listeners, which are bound once.
  const live = useRef({ press, back, pressCall, onClose })
  useEffect(() => {
    live.current = { press, back, pressCall, onClose }
  })

  useEffect(() => {
    // A desk gets the caret straight away; on a phone the on-screen keys are the keyboard.
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) inputRef.current?.focus()
  }, [])

  useEffect(() => {
    // Capture phase, so the desk's own shortcuts (1–9 = results, C = call the
    // open lead) never see a key meant for the pad.
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      const active = document.activeElement as HTMLElement | null
      const onInput = active === inputRef.current
      if (!onInput && isTypingTarget(active)) return
      const pad = live.current
      if (event.key === 'Escape') {
        event.preventDefault()
        pad.onClose()
        return
      }
      if (event.key === 'Enter') {
        const otherButton = !onInput && active && (active.tagName === 'BUTTON' || active.tagName === 'A') && !active.classList.contains('pad-key')
        if (otherButton) return
        event.preventDefault()
        pad.pressCall()
        return
      }
      if (onInput) return // the field types, deletes and pastes by itself
      if (/^[0-9*#]$/.test(event.key)) {
        event.preventDefault()
        pad.press(event.key)
      } else if (event.key === 'Backspace') {
        event.preventDefault()
        pad.back()
      }
    }
    const onPaste = (event: ClipboardEvent) => {
      const active = document.activeElement as HTMLElement | null
      if (active === inputRef.current || isTypingTarget(active)) return
      const text = event.clipboardData?.getData('text') ?? ''
      if (!/\d/.test(text)) return
      event.preventDefault()
      setTyped(cleanTyped(text))
    }
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target || rootRef.current?.contains(target) || ignore?.current?.contains(target)) return
      live.current.onClose()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('paste', onPaste)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('paste', onPaste)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [ignore])

  function remember(number: string) {
    const next = pushRecent(recent, number)
    setRecent(next)
    saveRecent(next)
  }

  return (
    <>
      <div className="pad-backdrop" aria-hidden="true" />
      <div ref={rootRef} className="pad" role="dialog" aria-label="Dial pad">
        <div className="pad-grab" aria-hidden="true" />
        <div className="pad-head">
          <h3>Dial pad</h3>
          <button type="button" className="pad-close" aria-label="Close the dial pad" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="pad-display">
          <input
            ref={inputRef}
            type="tel"
            inputMode="none"
            autoComplete="off"
            aria-label="Number to call"
            placeholder="Enter a number"
            value={formatAsTyped(typed)}
            onChange={(event) => setTyped(cleanTyped(event.target.value))}
            onPaste={(event) => {
              const text = event.clipboardData.getData('text')
              // A whole pasted number replaces what's there; a few digits add on.
              if (text.replace(/\D/g, '').length >= 10) {
                event.preventDefault()
                setTyped(cleanTyped(text))
              }
            }}
          />
          <button
            type="button"
            className="pad-back"
            aria-label="Delete the last digit"
            disabled={!typed}
            onPointerDown={(event) => event.preventDefault()}
            onClick={back}
          >
            <Delete aria-hidden="true" />
          </button>
        </div>
        <div className="pad-keys" role="group" aria-label="Keypad">
          {KEYS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={item.key === '*' ? 'pad-key pad-star' : 'pad-key'}
              aria-label={item.key === '*' ? 'Star' : item.key === '#' ? 'Pound' : item.key}
              // Keep the caret in the field on a desk.
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => press(item.key)}
            >
              <b>{item.key}</b>
              <small>{item.sub || ' '}</small>
            </button>
          ))}
        </div>
        <div ref={callRef} className="pad-call">
          {e164 ? (
            <CallButton
              key={e164}
              appearance="desk"
              target={{ kind: 'number', id: e164 }}
              tel={e164}
              who={formatDialed(e164)}
              canOverrideHours={canOverrideHours}
              disabled={disabled}
              onDialed={() => {
                remember(e164)
                onClose()
              }}
            />
          ) : (
            <button type="button" className="btn" disabled>
              Call
            </button>
          )}
        </div>
        {/[*#]/.test(typed) ? <p className="muted pad-hint">* and # are for menus during a call. Use the call bar&rsquo;s keypad.</p> : null}
        <p className="muted pad-note">Do-not-call and calling hours still apply. Known clients and leads are matched by number.</p>
        {recent.length ? (
          <div className="pad-recent">
            <h4>Recent</h4>
            <ul>
              {recent.map((number) => (
                <li key={number}>
                  <button type="button" onClick={() => setTyped(number.slice(2))}>
                    {maskDialed(number)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </>
  )
}
