'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { isStandalone, startInstallStore } from './install-store'
import { inAppHref } from './in-app-links'
import { InstallHelpSheet } from './install-app'

/** Re-check for a new deployment at most this often while the app is open. */
const UPDATE_CHECK_MS = 30 * 60 * 1000

/**
 * The installed app's runtime, mounted once by the root layout
 * (docs/MOBILE.md "Installed app"):
 *
 * 1. Registers the app-shell service worker `/sw.js` (scope `/`). Production
 *    builds only: in `next dev` a worker would cache chunks that change on
 *    every save. Team chat's push worker keeps its own scope (/chat-sw/).
 * 2. When a new deployment's worker takes over, offers "Reload" in a toast.
 *    An installed iPhone app can stay alive for days; this is how it learns
 *    there is a new version without the user knowing to force-quit it.
 * 3. Adopts the install prompt (install-store.ts).
 * 4. Publishes the on-screen keyboard to CSS (`--vvh`, `--vv-top`, `--kb`,
 *    `html.kb-open`) so full-screen sheets keep their composer above it.
 * 5. In standalone mode, keeps same-origin page links that say
 *    `target="_blank"` inside the app (in-app-links.ts).
 */
export function InstalledAppRuntime() {
  const router = useRouter()

  useEffect(() => {
    startInstallStore()
  }, [])

  // 1 + 2. Service worker + update toast.
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return
    const sw = navigator.serviceWorker
    let hadController = Boolean(sw.controller)
    let lastCheck = Date.now()
    let registration: ServiceWorkerRegistration | null = null

    const onControllerChange = () => {
      // The first install claims the page too; that is not an "update".
      if (!hadController) {
        hadController = true
        return
      }
      toast('A new version of ProdigyFlo is ready.', {
        id: 'pf-app-update',
        duration: Infinity,
        action: { label: 'Reload', onClick: () => window.location.reload() },
      })
    }
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !registration) return
      if (Date.now() - lastCheck < UPDATE_CHECK_MS) return
      lastCheck = Date.now()
      registration.update().catch(() => {})
    }

    sw.addEventListener('controllerchange', onControllerChange)
    document.addEventListener('visibilitychange', onVisible)
    sw.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then((reg) => {
        registration = reg
      })
      .catch((err) => console.warn('[pwa] service worker registration failed', err))
    return () => {
      sw.removeEventListener('controllerchange', onControllerChange)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // 4. Keyboard-aware viewport variables.
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    let frame = 0
    const apply = () => {
      frame = 0
      const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
      root.style.setProperty('--vvh', `${Math.round(vv.height)}px`)
      root.style.setProperty('--vv-top', `${Math.round(vv.offsetTop)}px`)
      root.style.setProperty('--kb', `${kb}px`)
      // A pinch-zoom also shrinks the visual viewport; only a tall, unzoomed gap is a keyboard.
      root.classList.toggle('kb-open', kb > 120 && vv.scale <= 1.01)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply)
    }
    apply()
    vv.addEventListener('resize', schedule)
    vv.addEventListener('scroll', schedule)
    return () => {
      vv.removeEventListener('resize', schedule)
      vv.removeEventListener('scroll', schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  // 5. Same-origin new-tab links stay in the installed app.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      if (!isStandalone()) return
      const anchor = (event.target as Element | null)?.closest?.('a[target="_blank"]')
      if (!(anchor instanceof HTMLAnchorElement)) return
      const href = inAppHref(anchor, window.location.origin)
      if (!href) return
      event.preventDefault()
      router.push(href)
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [router])

  return <InstallHelpSheet />
}
