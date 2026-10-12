/**
 * Device notifications for the Team chat on ProdigyFlo (docs/TEAM_CHAT_PARITY.md
 * F2). The chat Worker sends Web Push with its own VAPID key; this browser
 * holds the subscription through a push-only service worker, /chat-sw.js,
 * registered on a scope no page lives under, so it never controls a page,
 * never caches and never sees a fetch.
 *
 * Pure helpers here; the switch is ./push-toggle.tsx.
 */

export const CHAT_SW_URL = '/chat-sw.js'
/** No page is served under this path: the worker controls nothing. */
export const CHAT_SW_SCOPE = '/chat-sw/'

/** VAPID public keys travel base64url; PushManager wants the raw bytes. */
export function vapidKeyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4)
  const b64 = (base64url + pad).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export type PushSupport = 'ok' | 'ios_install' | 'unsupported'

/**
 * What this browser can do. iPhone/iPad Safari only offers Web Push to a site
 * added to the Home Screen and opened from there (iOS 16.4+).
 */
export function pushSupport(env: { userAgent: string; standalone: boolean; hasSw: boolean; hasPush: boolean; hasNotification: boolean; maxTouchPoints?: number }): PushSupport {
  const ios = /iPhone|iPad|iPod/.test(env.userAgent) || (/Macintosh/.test(env.userAgent) && (env.maxTouchPoints ?? 0) > 1)
  if (env.hasSw && env.hasPush && env.hasNotification) return 'ok'
  if (ios && !env.standalone) return 'ios_install'
  return 'unsupported'
}

export function browserPushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported'
  const nav = navigator as Navigator & { standalone?: boolean }
  return pushSupport({
    userAgent: nav.userAgent,
    standalone: Boolean(nav.standalone) || window.matchMedia?.('(display-mode: standalone)').matches === true,
    hasSw: 'serviceWorker' in nav,
    hasPush: 'PushManager' in window,
    hasNotification: 'Notification' in window,
    maxTouchPoints: nav.maxTouchPoints,
  })
}
