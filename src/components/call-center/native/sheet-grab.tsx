'use client'

import { useLayoutEffect, useRef } from 'react'
import { useSheet } from './use-sheet'

/**
 * A grab handle for a sheet whose element this code does not own (a UI-kit
 * dialog): it makes its parent draggable to close, once CSS lays that parent
 * out as a bottom sheet. The kit keeps its own focus trap and scroll lock.
 */
export function SheetGrab({ onClose, className = '' }: { onClose: () => void; className?: string }) {
  const grab = useRef<HTMLSpanElement>(null)
  const host = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    host.current = grab.current?.parentElement ?? null
  }, [])
  useSheet(host, onClose, { lock: false })
  return <span ref={grab} className={`cc-grab ${className}`} aria-hidden="true" />
}
