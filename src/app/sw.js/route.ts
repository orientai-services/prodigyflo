import { serviceWorkerSource } from '@/lib/pwa/service-worker'

/**
 * `/sw.js`: the app-shell service worker (src/lib/pwa/service-worker.ts).
 *
 * Prerendered once per build. The version is the deployment's commit (or the
 * build time locally), so each deploy serves a byte-different worker; that is
 * what triggers the in-app "new version, reload" toast. The response must
 * never be cached by the browser or a CDN, or updates would stall for a day.
 * Public in src/proxy.ts: a worker's update check carries no session and must
 * never be redirected to /login, or the browser drops the worker.
 */
export const dynamic = 'force-static'

const VERSION =
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ||
  process.env.VERCEL_DEPLOYMENT_ID ||
  `b${Date.now().toString(36)}`

export function GET() {
  return new Response(serviceWorkerSource(VERSION), {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-cache, no-store, must-revalidate',
      'x-content-type-options': 'nosniff',
    },
  })
}
