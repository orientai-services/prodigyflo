'use client'

import { useSyncExternalStore } from 'react'

/**
 * Install state for the "Install app" entries (docs/MOBILE.md "Installed app").
 *
 * Chrome and Samsung Internet hand out ONE `beforeinstallprompt` event, often
 * before React has hydrated, so the root layout's inline script parks it on
 * `window.__pfInstall` and this store adopts it. Nothing calls preventDefault:
 * Android's own install banner stays, our button is a second way in.
 *
 * Platform sniffing here only picks which how-to to show (Safari and Chrome on
 * iOS put "Add to Home Screen" in different menus). Layout never depends on
 * it; iPadOS reports a Mac user agent, so it is recognised by touch points.
 */
export type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export type InstallPlatform = 'ios-safari' | 'ios-chrome' | 'ios-other' | 'android' | 'desktop'

export type InstallState = {
  /** Already running from the home screen / as an installed window. */
  standalone: boolean
  /** The deferred browser prompt (Chrome, Edge, Samsung Internet), when one was offered. */
  canPrompt: boolean
  platform: InstallPlatform
  /** The how-to sheet (no browser prompt available) is open. */
  helpOpen: boolean
}

declare global {
  interface Window {
    __pfInstall?: InstallPromptEvent | null
  }
  interface Navigator {
    standalone?: boolean
  }
}

const SERVER: InstallState = { standalone: false, canPrompt: false, platform: 'desktop', helpOpen: false }
let state: InstallState = SERVER
let deferred: InstallPromptEvent | null = null
let helpOpen = false
const listeners = new Set<() => void>()

export function detectPlatform(ua: string, maxTouchPoints: number): InstallPlatform {
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)
  if (ios) {
    if (/CriOS/.test(ua)) return 'ios-chrome'
    if (/FxiOS|EdgiOS|OPiOS|GSA\//.test(ua)) return 'ios-other'
    return 'ios-safari'
  }
  return /Android/.test(ua) ? 'android' : 'desktop'
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches ||
      window.matchMedia('(display-mode: window-controls-overlay)').matches ||
      window.navigator.standalone === true
    )
  } catch {
    return false
  }
}

function emit() {
  state = {
    standalone: isStandalone(),
    canPrompt: Boolean(deferred),
    platform: detectPlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0),
    helpOpen,
  }
  document.documentElement.classList.toggle('pf-standalone', state.standalone)
  for (const l of listeners) l()
}

let started = false
/** Wires the browser events once (called by InstalledAppRuntime). */
export function startInstallStore() {
  if (started || typeof window === 'undefined') return
  started = true
  deferred = window.__pfInstall ?? null
  window.addEventListener('beforeinstallprompt', (e) => {
    deferred = e as InstallPromptEvent
    window.__pfInstall = deferred
    emit()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    window.__pfInstall = null
    emit()
  })
  try {
    window.matchMedia('(display-mode: standalone)').addEventListener('change', emit)
  } catch {
    // Old Safari: no MediaQueryList events. The class set by the head script stands.
  }
  emit()
}

/** Shows the browser's own install dialog. False when there is none to show. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = deferred
  if (!event) return 'unavailable'
  deferred = null
  window.__pfInstall = null
  emit()
  try {
    await event.prompt()
    const { outcome } = await event.userChoice
    return outcome
  } catch {
    return 'unavailable'
  }
}

/** Opens / closes the illustrated how-to (iOS, or any browser without a prompt). */
export function setInstallHelp(open: boolean) {
  helpOpen = open
  emit()
}

/**
 * What every "Install app" entry calls: the browser's own dialog when there is
 * one (Android, desktop Chrome/Edge), otherwise the how-to sheet. Must run
 * inside the click: browsers only show the prompt for a user gesture.
 */
export async function startInstall() {
  if (deferred) {
    const outcome = await promptInstall()
    if (outcome !== 'unavailable') return
  }
  setInstallHelp(true)
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      startInstallStore()
      return () => listeners.delete(cb)
    },
    () => state,
    () => SERVER,
  )
}
