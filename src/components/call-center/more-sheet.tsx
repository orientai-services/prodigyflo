'use client'

import Link from 'next/link'
import { useEffect, useRef, type RefObject } from 'react'
import { Megaphone, Settings2, UsersRound, X } from 'lucide-react'
import { ADS_BASE, sectionHref } from '@/lib/call-center/app-shell'
import type { PhoneStatus } from '@/lib/telephony/ui/phone-status'
import { DialerModeSwitch } from './dialer-mode-switch'
import { InstallAppEntry } from '@/components/pwa/install-app'

/**
 * More (docs/DIALER_APP.md §1): Campaigns, Team, a status block (live
 * refresh, the phone, the caller line, who is signed in), Settings (the
 * phone settings sheet) and the Dialer-mode switch. A bottom sheet on a
 * phone, a popover under its button on a desk.
 */
export function MoreSheet({
  adsAllowed,
  phone,
  line,
  updated,
  viewer,
  toggle,
  onClose,
  onSettings,
}: {
  adsAllowed: boolean
  phone: PhoneStatus
  /** "Office · (725) 888-8560": the default caller line, or null when calling is off. */
  line: string | null
  /** "Updated 2 min ago". */
  updated: string
  viewer: { name: string; role: string } | null
  /** The button that opened it: a press on it is not an outside click. */
  toggle: RefObject<HTMLElement | null>
  onClose: () => void
  onSettings: () => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const live = useRef({ onClose, toggle })
  useEffect(() => {
    live.current = { onClose, toggle }
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
      if (live.current.toggle.current?.contains(target)) return
      live.current.onClose()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onPointer)
    rootRef.current?.querySelector<HTMLElement>('a, button')?.focus({ preventScroll: true })
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [])

  return (
    <>
      <div className="more-backdrop" aria-hidden="true" />
      <div ref={rootRef} className="more-sheet" role="dialog" aria-label="More">
        <div className="pad-grab" aria-hidden="true" />
        <div className="pad-head">
          <h3>More</h3>
          <button type="button" className="pad-close" aria-label="Close" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
        <ul className="more-links">
          {adsAllowed ? (
            <li>
              <Link href={ADS_BASE} onClick={onClose}>
                <Megaphone aria-hidden="true" />
                <span>
                  <b>Campaigns</b>
                  <small>The ads and the leads they bring</small>
                </span>
              </Link>
            </li>
          ) : null}
          <li>
            <Link href={sectionHref('team')} onClick={onClose}>
              <UsersRound aria-hidden="true" />
              <span>
                <b>Team</b>
                <small>Who is on the phone and what they did today</small>
              </span>
            </Link>
          </li>
          <li>
            <button
              type="button"
              onClick={() => {
                onClose()
                onSettings()
              }}
            >
              <Settings2 aria-hidden="true" />
              <span>
                <b>Settings</b>
                <small>Microphone, speaker, caller line and a test call</small>
              </span>
            </button>
          </li>
          {/* Hidden when already running as the installed app. */}
          <InstallAppEntry variant="more" onPick={onClose} />
        </ul>
        <dl className="more-status">
          <div>
            <dt>Desk</dt>
            <dd><span className="live-dot" aria-hidden="true" />Live · {updated}</dd>
          </div>
          <div>
            <dt>Phone</dt>
            <dd><span className={`phone-chip ${phone.tone}`}><span className="phone-dot" aria-hidden="true" />{phone.label}</span></dd>
          </div>
          {line ? (
            <div>
              <dt>Calls go out from</dt>
              <dd>{line}</dd>
            </div>
          ) : null}
          {viewer ? (
            <div>
              <dt>Signed in</dt>
              <dd>{viewer.name} · {viewer.role}</dd>
            </div>
          ) : null}
        </dl>
        <div className="more-switch">
          <DialerModeSwitch on />
        </div>
      </div>
    </>
  )
}
