'use client'

import { useEffect, useRef } from 'react'
import { Download, Ellipsis, EllipsisVertical, Share, SquarePlus, X } from 'lucide-react'
import { setInstallHelp, startInstall, useInstallState, type InstallPlatform } from './install-store'
import './install.css'

/**
 * "Install app" (docs/MOBILE.md "Installed app"). Android and desktop Chrome
 * get the browser's own install dialog; iPhone and iPad (which have no such
 * dialog) get a short illustrated how-to. Hidden once the app is running from
 * the home screen.
 *
 * `variant` only changes the trigger's look so it sits naturally in each
 * place: the Call Center's More sheet, the desk rail, the sign-in page.
 * The sheet itself is mounted once, by InstalledAppRuntime.
 */
export function InstallAppEntry({ variant, onPick }: { variant: 'more' | 'rail' | 'link'; /** Runs first, e.g. to close the menu it sits in. */ onPick?: () => void }) {
  const { standalone, canPrompt, platform } = useInstallState()
  if (standalone) return null
  const hint = canPrompt ? 'Adds ProdigyFlo to this device like any other app' : platform.startsWith('ios') ? 'Put ProdigyFlo on your Home Screen, full screen' : 'Put ProdigyFlo on this device, full screen'
  const go = () => {
    onPick?.()
    void startInstall()
  }

  if (variant === 'more') {
    return (
      <li>
        <button type="button" onClick={go}>
          <Download aria-hidden="true" />
          <span>
            <b>Install app</b>
            <small>{hint}</small>
          </span>
        </button>
      </li>
    )
  }
  if (variant === 'rail') {
    return (
      <button type="button" className="out pwa-install-rail" onClick={go}>
        Install app
      </button>
    )
  }
  return (
    <button type="button" className="pwa-install-link" onClick={go}>
      <Download aria-hidden="true" />
      Install the app on this phone
    </button>
  )
}

type Step = { icon?: React.ReactNode; text: React.ReactNode }

function stepsFor(platform: InstallPlatform): { title: string; steps: Step[]; note?: string } {
  const add = <SquarePlus aria-hidden="true" />
  switch (platform) {
    case 'ios-safari':
      return {
        title: 'Add ProdigyFlo to your Home Screen',
        steps: [
          { icon: <Share aria-hidden="true" />, text: <>Tap <b>Share</b> in Safari&rsquo;s toolbar. On iOS 26 it is inside the <b>⋯</b> menu next to the address.</> },
          { icon: add, text: <>Scroll down and tap <b>Add to Home Screen</b>.</> },
          { text: <>Leave <b>Open as Web App</b> switched on, then tap <b>Add</b>.</> },
        ],
        note: 'Open ProdigyFlo from the new icon. It runs full screen, with no Safari buttons.',
      }
    case 'ios-chrome':
      return {
        title: 'Add ProdigyFlo to your Home Screen',
        steps: [
          { icon: <Share aria-hidden="true" />, text: <>Tap <b>Share</b> in Chrome&rsquo;s address bar (or <b>⋯</b> › <b>Share</b>).</> },
          { icon: add, text: <>Tap <b>Add to Home Screen</b>.</> },
          { text: <>Tap <b>Add</b>.</> },
        ],
        note: 'Open ProdigyFlo from the new icon. It runs full screen, with no browser buttons.',
      }
    case 'ios-other':
      return {
        title: 'Add ProdigyFlo to your Home Screen',
        steps: [
          { icon: <Share aria-hidden="true" />, text: <>Open your browser&rsquo;s <b>Share</b> menu.</> },
          { icon: add, text: <>Tap <b>Add to Home Screen</b>, then <b>Add</b>.</> },
        ],
        note: 'If you do not see it, open this page in Safari and add it from there.',
      }
    case 'android':
      return {
        title: 'Install ProdigyFlo',
        steps: [
          { icon: <EllipsisVertical aria-hidden="true" />, text: <>Open the browser menu (<b>⋮</b> in Chrome, <b>≡</b> in Samsung Internet).</> },
          { icon: add, text: <>Tap <b>Install app</b> or <b>Add to Home screen</b>.</> },
        ],
      }
    default:
      return {
        title: 'Install ProdigyFlo',
        steps: [
          { icon: <Download aria-hidden="true" />, text: <>Click the install icon at the right end of the address bar, or open the browser menu (<Ellipsis aria-hidden="true" className="pwa-inline-icon" />) › <b>Install ProdigyFlo</b>.</> },
          { text: <>In Safari on a Mac: <b>File</b> › <b>Add to Dock</b>.</> },
        ],
      }
  }
}

/** The how-to sheet: a bottom sheet on a phone, a small dialog on a desk. */
export function InstallHelpSheet() {
  const { helpOpen, platform } = useInstallState()
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!helpOpen) return
    const back = document.activeElement as HTMLElement | null
    closeRef.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setInstallHelp(false)
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      back?.focus?.({ preventScroll: true })
    }
  }, [helpOpen])

  if (!helpOpen) return null
  const { title, steps, note } = stepsFor(platform)
  return (
    <div className="pwa-install-root">
      <div className="pwa-install-backdrop" aria-hidden="true" onClick={() => setInstallHelp(false)} />
      <div className="pwa-install-sheet" role="dialog" aria-modal="true" aria-labelledby="pwa-install-title">
        <div className="pwa-install-grab" aria-hidden="true" />
        <div className="pwa-install-head">
          {/* eslint-disable-next-line @next/next/no-img-element -- a 48 px static brand icon; next/image buys nothing here */}
          <img src="/brand/prodigyflo/icon-192.png" alt="" width={48} height={48} />
          <h2 id="pwa-install-title">{title}</h2>
          <button ref={closeRef} type="button" className="pwa-install-close" aria-label="Close" onClick={() => setInstallHelp(false)}>
            <X aria-hidden="true" />
          </button>
        </div>
        <ol className="pwa-install-steps">
          {steps.map((step, i) => (
            <li key={i}>
              <span className="pwa-install-num" aria-hidden="true">{i + 1}</span>
              <span className="pwa-install-text">{step.text}</span>
              {step.icon ? <span className="pwa-install-glyph" aria-hidden="true">{step.icon}</span> : null}
            </li>
          ))}
        </ol>
        {note ? <p className="pwa-install-note">{note}</p> : null}
        <p className="pwa-install-note">Already have a ProdigyFlo icon that opens with browser buttons? Delete it first (press and hold › Remove App), then add it again.</p>
        <button type="button" className="pwa-install-done" onClick={() => setInstallHelp(false)}>
          Got it
        </button>
      </div>
    </div>
  )
}
