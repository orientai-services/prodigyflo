'use client'

import { useEffect, useLayoutEffect, useRef } from 'react'
import { EMOJI } from './message-logic'

/**
 * The emoji picker SunOff Chat uses (same 61, same order), for reactions and for the composer.
 * Desktop: a popover above (or below) the button that opened it. Phones: a
 * strip along the bottom of the screen. Arrows move by one / by a row of 8,
 * Escape or a tap outside closes it.
 */
export function EmojiPicker({ anchor, title, onPick, onClose }: { anchor: HTMLElement | null; title: string; onPick: (e: string) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const phone = window.matchMedia('(max-width: 760px)').matches
    const vv = window.visualViewport
    const vh = vv?.height ?? window.innerHeight
    if (phone || !anchor) {
      el.style.bottom = `${Math.max(8, window.innerHeight - ((vv?.offsetTop ?? 0) + vh) + 8)}px`
    } else {
      const r = anchor.getBoundingClientRect()
      const w = el.offsetWidth
      const h = el.offsetHeight
      const left = Math.min(window.innerWidth - w - 8, Math.max(8, r.right - w))
      let top = r.top - h - 8
      if (top < 8) top = Math.min(window.innerHeight - h - 8, r.bottom + 8)
      el.style.left = `${left}px`
      el.style.top = `${top}px`
    }
    el.style.visibility = 'visible'
    el.querySelector('button')?.focus({ preventScroll: true })
  }, [anchor])

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node
      if (box.current?.contains(t) || (anchor && anchor.contains(t))) return
      onClose()
    }
    document.addEventListener('pointerdown', down, true)
    return () => document.removeEventListener('pointerdown', down, true)
  }, [anchor, onClose])

  return (
    <div
      ref={box}
      className="chat-emo"
      role="dialog"
      aria-label={title}
      style={{ visibility: 'hidden' }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
          anchor?.focus()
          return
        }
        const step = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: 8, ArrowUp: -8 } as Record<string, number>)[e.key]
        if (!step) return
        const bs = [...(box.current?.querySelectorAll('button') ?? [])]
        const i = bs.indexOf(document.activeElement as HTMLButtonElement)
        if (i < 0) return
        e.preventDefault()
        bs[Math.max(0, Math.min(bs.length - 1, i + step))]?.focus()
      }}
    >
      <p className="chat-emo-k">{title}</p>
      <div className="chat-emo-g">
        {EMOJI.map((e) => (
          <button key={e} type="button" aria-label={e} onClick={() => onPick(e)}>
            {e}
          </button>
        ))}
      </div>
    </div>
  )
}
