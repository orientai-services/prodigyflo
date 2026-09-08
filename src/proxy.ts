import { NextResponse, type NextRequest } from 'next/server'

/**
 * Next 16 renamed `middleware` to `proxy` (nodejs runtime).
 *
 * This is a coarse gate only — it redirects signed-out visitors away from app
 * routes so they never see a flash of the shell. Real authorization happens in
 * `requireUser` / `requirePermission` on the server for every page and action.
 */
const PUBLIC_PREFIXES = [
  '/login',
  // Self-service auth: request + complete a password reset. Magic-link
  // completion lives under /login/magic, already covered by '/login'.
  '/forgot-password',
  '/reset-password',
  '/survey',
  '/api/auth',
  '/api/webhooks',
  // Inbound form/sheet intake authenticates with a per-source HMAC, not a session.
  '/api/intake',
  // Meta webhooks sign with X-Hub-Signature-256; invite links carry their own token.
  '/api/meta',
  '/invite',
  // Public legal pages (privacy policy is linked from Meta app settings + lead forms).
  '/privacy',
  // Inbound messages sign with X-Inbound-Signature; the job runner uses a Bearer token.
  '/api/inbound',
  '/api/jobs',
  // Carrier webhooks: the phone network posts here with no session and no
  // bearer token, so the X-Twilio-Signature check inside each route IS the
  // authentication. Gating them here would answer a real customer's call with
  // a redirect to /login. See src/lib/telephony/signature.ts.
  '/api/telephony',
  '/_next',
  '/favicon',
  // PWA manifests. Browsers fetch a manifest with `crossorigin="anonymous"`
  // unless told otherwise, so this request arrives WITHOUT the session cookie —
  // gating it would redirect the fetch to /login and the install would silently
  // fall back to the browser's default icon and title. It leaks nothing: the
  // response is a fixed name/colour/icon set per account slug, all of which are
  // already public assets under /brand. See src/app/manifest/[slug]/route.ts.
  '/manifest/',
  '/brand/',
]

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  const hasSession =
    request.cookies.has('authjs.session-token') ||
    request.cookies.has('__Secure-authjs.session-token')

  if (!hasSession) {
    const url = new URL('/login', request.url)
    if (pathname !== '/') url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\.(?:png|jpg|svg|ico|webp)$).*)'],
}
