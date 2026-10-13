'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Settings2, X } from 'lucide-react'
import { phoneStatus, type PhoneStatus } from '@/lib/telephony/ui/phone-status'
import { PhoneSettings } from '@/components/voice/phone-settings'
import { useVoice } from '@/components/voice/voice-provider'
import { useSheet } from './native/use-sheet'
import './phone-pill.css'

/** Below this width the sheet is a bottom sheet instead of a popover under the pill. */
const PHONE_QUERY = '(max-width: 767.98px)'

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
 * The phone status pill: green "Phone ready" or "On a call", amber
 * "Connecting…", red "Phone off". Tapping it opens the phone sheet: why the
 * light is the colour it is, the caller line, ringtone, microphone and
 * speaker, Test connection, and for an owner the way into Phone setup.
 *
 * Self-contained so any header can mount it: it keeps its own open state and
 * styles (phone-pill.css; `.fd-tw` keeps the final-desk reset off it). On a
 * desk the sheet is a popover under the pill; on a phone it is a bottom sheet
 * portalled to the body, so no ancestor's stacking or overflow can clip it.
 */
export function PhoneStatusPill({
  voiceNote,
  onOpenSetup,
}: {
  /** Why browser calling is off (plain English), shown in the sheet when the provider is absent. */
  voiceNote?: string | null
  /** Owners only: opens the Phone setup sheet. */
  onOpenSetup?: () => void
}) {
  const status = usePhoneStatus(voiceNote)
  const [open, setOpen] = useState(false)
  const [phone, setPhone] = useState(false)
  const pillRef = useRef<HTMLButtonElement>(null)

  const toggle = () => {
    setPhone(window.matchMedia(PHONE_QUERY).matches)
    setOpen((now) => !now)
  }

  const sheet = open ? (
    <PhoneSheet status={status} pill={pillRef} onClose={() => setOpen(false)} onOpenSetup={onOpenSetup} />
  ) : null

  return (
    <span className="phone-status fd-tw">
      <button
        ref={pillRef}
        type="button"
        className={`phone-pill ${status.tone}${open ? ' on' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${status.label}. Phone settings and test.`}
        title={status.reason ?? 'Phone settings and test'}
        onClick={toggle}
      >
        <span className="phone-dot" aria-hidden="true" />
        <span>{status.label}</span>
      </button>
      {sheet && phone ? createPortal(sheet, document.body) : sheet}
    </span>
  )
}

function PhoneSheet({
  status,
  pill,
  onClose,
  onOpenSetup,
}: {
  status: PhoneStatus
  /** A press on the pill toggles; it is not an outside click. */
  pill: RefObject<HTMLElement | null>
  onClose: () => void
  onOpenSetup?: () => void
}) {
  const voice = useVoice()
  const rootRef = useRef<HTMLDivElement>(null)
  useSheet(rootRef, onClose)
  const live = useRef({ onClose, pill })
  useEffect(() => {
    live.current = { onClose, pill }
  })

  useEffect(() => {
    // Capture phase, so page shortcuts never see the Escape meant for the sheet.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      live.current.onClose()
    }
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target || rootRef.current?.contains(target) || live.current.pill.current?.contains(target)) return
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
    <span className="phone-status-layer fd-tw">
      <span className="phone-backdrop" aria-hidden="true" />
      <div ref={rootRef} className="phone-sheet" role="dialog" aria-label="Phone">
        <span className="phone-grab" aria-hidden="true" />
        <div className="phone-head">
          <h3>Phone</h3>
          <button type="button" className="phone-close" aria-label="Close phone settings" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
        <p className={`phone-state ${status.tone}`} role="status">
          <span className="phone-dot" aria-hidden="true" />
          <span>
            <b>{status.label}</b>
            {status.reason ? <span className="phone-reason">{status.reason}</span> : null}
          </span>
        </p>
        {voice ? (
          <div className="phone-settings">
            <PhoneSettings />
          </div>
        ) : null}
        {onOpenSetup ? (
          <button
            type="button"
            className="phone-setup-open"
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
    </span>
  )
}
