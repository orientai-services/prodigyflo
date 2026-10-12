// ProdigyFlo Team chat notifications (docs/TEAM_CHAT_PARITY.md F2). Push only: no fetch handler, no cache, and it is
// registered on the scope /chat-sw/, where no page lives, so it never controls or serves a ProdigyFlo page.
// The chat Worker (chat.sunoff.app) sends {title, body, url, tag:"chat-<channel>", kind:"chat"}; url is
// https://www.prodigyflo.ai/call-center?s=messages#c=<channel>[&thread=<root>].
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

const ICON = '/brand/prodigyflo/icon-192.png'
const HOME = '/call-center?s=messages'

// Only our own Call Center: a payload can never send a tap anywhere else.
function safeUrl(raw) {
  try {
    const u = new URL(String(raw || HOME), self.location.origin)
    if (u.pathname === '/call-center') return self.location.origin + u.pathname + u.search + u.hash
  } catch {
    // fall through
  }
  return self.location.origin + HOME
}

self.addEventListener('push', (e) => {
  let d = {}
  try {
    d = e.data ? e.data.json() : {}
  } catch {
    d = { title: 'Team chat', body: e.data ? e.data.text() : '' }
  }
  const title = String(d.title || 'Team chat').slice(0, 120)
  e.waitUntil(
    self.registration.showNotification(title, {
      body: String(d.body || '').slice(0, 240),
      icon: ICON,
      badge: ICON,
      tag: String(d.tag || 'chat'),
      renotify: true,
      silent: !!d.silent,
      data: { url: safeUrl(d.url), kind: d.kind || 'chat' },
    }),
  )
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const url = safeUrl(e.notification.data && e.notification.data.url)
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // An open Call Center routes in place (use-chat-host.ts), so a live call is never dropped by a reload.
      const desk = list.find((c) => {
        try {
          const u = new URL(c.url)
          return u.origin === self.location.origin && u.pathname === '/call-center'
        } catch {
          return false
        }
      })
      if (desk) {
        desk.postMessage({ pfChatGo: 1, url })
        return desk.focus()
      }
      return self.clients.openWindow(url)
    }),
  )
})
