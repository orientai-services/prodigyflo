'use client'

import { useEffect, useRef, type Ref, type RefObject } from 'react'
import { Settings2, X } from 'lucide-react'
import { phoneStatus, type PhoneStatus } from '@/lib/telephony/ui/phone-status'
import { PhoneSettings } from '@/components/voice/phone-settings'
import { useVoice } from '@/components/voice/voice-provider'

/** The pill's light from `useVoice()`, or red with the server's reason when browser calling is off. */
export function usePhoneStatus(voiceNote?: string | null): PhoneStatus {
  const voice = useVoice()
  return phoneStatus(
    voice
      ? {
          mode: voice.setup.mode,
          lines: voice.setup.lines.length,
          leader: voice.leader,
          registered: voice.registered,
          status: voice.status,
          issue: voice.phoneIssue,
        }
      : null,
    voiceNote,
  )
}

/**
 * The phone status pill, top right of the Call Center header: green "Phone
 * ready", amber "Connecting…", red "Phone off", or "On a call". Tapping it
 * opens the phone sheet (`PhoneSheet`).
 */
export function PhonePill({
  status,
  open,
  onToggle,
  ref,
}: {
  status: PhoneStatus
  open: boolean
  onToggle: () => void
  ref?: Ref<HTMLButtonElement>
}) {
  return (
    <button
      ref={ref}
      type="button"
      className={`phone-pill ${status.tone}${open ? ' on' : ''}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`${status.label}. Phone settings and test.`}
      title={status.reason ?? 'Phone settings and test'}
      onClick={onToggle}
    >
      <span className="phone-dot" aria-hidden="true" />
      <span>{status.label}</span>
    </button>
  )
}

/**
 * The pill's sheet: why the light is the colour it is, the phone settings
 * and Test connection, and for an owner the way into Phone setup. A popover
 * under the pill on a desk, a bottom sheet on a phone (the parent mounts it
 * at the desk root there, like the dial pad).
 */
export function PhoneSheet({
  status,
  pill,
  bar,
  onClose,
  onOpenSetup,
}: {
  status: PhoneStatus
  /** The pill and the phone's bottom bar open the sheet: a press on either is not an outside click. */
  pill: RefObject<HTMLElement | null>
  bar: RefObject<HTMLElement | null>
  onClose: () => void
  /** Owners only: opens the Phone setup sheet. */
  onOpenSetup?: () => void
}) {
  const voice = useVoice()
  const rootRef = useRef<HTMLDivElement>(null)
  const live = useRef({ onClose, pill, bar })
  useEffect(() => {
    live.current = { onClose, pill, bar }
  })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      live.current.onClose()
    }
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target || rootRef.current?.contains(target)) return
      if (live.current.pill.current?.contains(target) || live.current.bar.current?.contains(target)) return
      live.current.onClose()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [])

  return (
    <>
      <div className="phone-backdrop" aria-hidden="true" />
      <div ref={rootRef} className="phone-sheet" role="dialog" aria-label="Phone">
        <div className="pad-grab" aria-hidden="true" />
        <div className="pad-head">
          <h3>Phone</h3>
          <button type="button" className="pad-close" aria-label="Close phone settings" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
        <p className={`phone-state ${status.tone}`} role="status">
          <span className="phone-dot" aria-hidden="true" />
          <span>
            <b>{status.label}</b>
            {status.reason ? <span className="muted">{status.reason}</span> : null}
          </span>
        </p>
        {/* The settings are Tailwind components: they keep their own spacing inside the desk. */}
        {voice ? (
          <div className="fd-tw phone-settings">
            <PhoneSettings />
          </div>
        ) : null}
        {onOpenSetup ? (
          <button
            type="button"
            className="btn secondary phone-setup-open"
            onClick={() => {
              onClose()
              onOpenSetup()
            }}
          >
            <Settings2 aria-hidden="true" />
            Phone setup
          </button>
        ) : null}
      </div>
    </>
  )
}
