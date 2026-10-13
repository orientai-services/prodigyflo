import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_CHROME, APP_PAPER, SPLASH_DEVICES, installedAppMetadata, splashFor, splashImages } from './app-chrome'
import { APP_SHORTCUTS, buildManifest } from './manifest'
import { OFFLINE_URL, serviceWorkerSource } from './service-worker'
import { inAppHref } from '@/components/pwa/in-app-links'
import { detectPlatform } from '@/components/pwa/install-store'
import { installedAppLanding, landingAfterLogin, staffRouteAllowed } from '@/lib/staff-routes'
import { BRANDED_SLUGS, brandFor } from '@/components/brand/org-brand'

const publicFile = (url: string) => path.join(process.cwd(), 'public', url.split('?')[0])

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  vi.doUnmock('@/lib/rbac')
})

describe('manifest', () => {
  it('is an installable standalone app that opens through the /app launcher', () => {
    const m = buildManifest(brandFor('prodigyflo'))
    expect(m).toMatchObject({
      id: '/',
      start_url: '/app',
      scope: '/',
      display: 'standalone',
      display_override: ['standalone'],
      orientation: 'any',
      theme_color: APP_CHROME,
      background_color: APP_PAPER,
      name: 'ProdigyFlo',
      short_name: 'ProdigyFlo',
    })
    expect(m.description.length).toBeGreaterThan(10)
    expect(m.categories).toContain('business')
    // start_url and every shortcut must sit inside the scope, or browsers drop them.
    for (const url of [m.start_url, ...m.shortcuts.map((s) => s.url)]) expect(url.startsWith(m.scope)).toBe(true)
  })

  it('carries 192 + 512 icons and a separate maskable one, all of which exist', () => {
    for (const slug of BRANDED_SLUGS) {
      const m = buildManifest(brandFor(slug))
      const any = m.icons.filter((i) => i.purpose === 'any').map((i) => i.sizes)
      expect(any).toEqual(expect.arrayContaining(['192x192', '512x512']))
      expect(m.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512')).toBe(true)
      for (const icon of m.icons) expect(existsSync(publicFile(icon.src)), icon.src).toBe(true)
    }
  })

  it('offers Today, Dialer, Messages and Leads shortcuts with real icons', () => {
    const m = buildManifest(brandFor('prodigyflo'))
    expect(m.shortcuts.map((s) => s.name)).toEqual(['Today', 'Dialer', 'Messages', 'Leads'])
    expect(APP_SHORTCUTS.find((s) => s.id === 'dialer')?.url).toBe('/call-center?pad=1')
    for (const s of m.shortcuts) for (const icon of s.icons) expect(existsSync(publicFile(icon.src)), icon.src).toBe(true)
  })

  it('the route serves it as application/manifest+json for each account', async () => {
    const { GET } = await import('@/app/manifest/[slug]/route')
    const res = await GET(new Request('https://www.prodigyflo.ai/manifest/scs'), { params: Promise.resolve({ slug: 'scs' }) })
    expect(res.headers.get('content-type')).toBe('application/manifest+json')
    const body = await res.json()
    expect(body.name).toBe('Solar Contract Services')
    expect(body.start_url).toBe('/app')
    expect(body.icons[0].src).toBe('/brand/scs/icon-192.png')
  })
})

describe('iOS metadata', () => {
  it('writes apple-mobile-web-app-capable by hand and uses the edge-to-edge status bar', () => {
    const meta = installedAppMetadata(brandFor('prodigyflo'))
    expect(meta.other).toEqual({ 'apple-mobile-web-app-capable': 'yes' })
    expect(meta.appleWebApp).toMatchObject({ capable: true, title: 'ProdigyFlo', statusBarStyle: 'black-translucent' })
    expect(meta.formatDetection).toMatchObject({ telephone: false })
  })

  it('lists home-screen icons for iPhone (180) and iPad (167, 152), all present', () => {
    for (const slug of BRANDED_SLUGS) {
      const apple = installedAppMetadata(brandFor(slug)).icons as { apple: { url: string; sizes: string }[] }
      expect(apple.apple.map((i) => i.sizes)).toEqual(['180x180', '167x167', '152x152'])
      for (const icon of apple.apple) expect(existsSync(publicFile(icon.url)), icon.url).toBe(true)
    }
  })

  it('has a startup image per device, orientation and colour scheme, with exact media queries', () => {
    const all = splashImages()
    expect(all).toHaveLength(SPLASH_DEVICES.length * 4)
    expect(new Set(all.map((s) => s.file)).size).toBe(all.length)
    const iPhone15 = all.filter((s) => s.media.includes('(device-width: 393px) and (device-height: 852px)'))
    expect(iPhone15.map((s) => s.file).sort()).toEqual(['1179x2556-dark.png', '1179x2556-light.png', '2556x1179-dark.png', '2556x1179-light.png'])
    const landscapeDark = splashFor('2556x1179-dark.png')
    expect(landscapeDark?.media).toBe('(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape) and (prefers-color-scheme: dark)')
    // iPads, both ways.
    expect(splashFor('1668x2388-light.png')).not.toBeNull()
    expect(splashFor('2388x1668-light.png')).not.toBeNull()
    expect(splashFor('../../etc/passwd')).toBeNull()
  })
})

describe('/app launcher', () => {
  it('lands the desk roles in the Call Center and lets /app through as a ?next=', () => {
    for (const flag of ['true', 'false']) {
      vi.stubEnv('PRODIGYFLO_FINAL_DESK', flag)
      expect(installedAppLanding('SUPER_ADMIN', '/board')).toBe('/call-center')
      expect(installedAppLanding('CLOSER', '/board')).toBe('/call-center')
      expect(installedAppLanding('CLIENT', '/login')).toBe('/login')
      expect(staffRouteAllowed('CLOSER', '/app')).toBe(true)
      expect(landingAfterLogin('CLOSER', '/app', '/board')).toBe('/app')
    }
  })

  it('redirects a signed-in user with a bare 307 and no caching', async () => {
    vi.doMock('@/lib/rbac', () => ({ getSessionUser: async () => ({ role: 'CLOSER', landingPath: null }) }))
    const { GET } = await import('@/app/app/route')
    const res = await GET(new Request('https://www.prodigyflo.ai/app'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('https://www.prodigyflo.ai/call-center')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('sends a signed-out launch to sign-in, which returns to /app', async () => {
    vi.doMock('@/lib/rbac', () => ({ getSessionUser: async () => null }))
    const { GET } = await import('@/app/app/route')
    const res = await GET(new Request('https://www.prodigyflo.ai/app'))
    expect(res.headers.get('location')).toBe('https://www.prodigyflo.ai/login?next=%2Fapp')
  })
})

describe('service worker source', () => {
  const src = serviceWorkerSource('abc123')

  it('is valid JavaScript stamped with the version', () => {
    expect(() => new Function(src)).not.toThrow()
    expect(src).toContain('const VERSION = "abc123"')
    expect(serviceWorkerSource('x"; alert(1); "')).toContain('const VERSION = "xalert1"')
  })

  it('precaches the offline page and serves only pages and hashed assets', () => {
    expect(src).toContain(`const OFFLINE_URL = "${OFFLINE_URL}"`)
    expect(src).toContain("request.mode === 'navigate'")
    expect(src).toContain("request.method !== 'GET'")
    expect(src).toContain("url.origin !== self.location.origin")
    // Push stays with the team-chat worker.
    expect(src).not.toMatch(/addEventListener\('push'/)
    expect(existsSync(publicFile(OFFLINE_URL))).toBe(true)
  })
})

describe('in-app links (standalone)', () => {
  const a = (href: string, download = false) => ({ href, hasAttribute: (n: string) => n === 'download' && download })
  const origin = 'https://www.prodigyflo.ai'
  it('keeps same-origin pages in the app', () => {
    expect(inAppHref(a('https://www.prodigyflo.ai/clients/c1?x=1#y'), origin)).toBe('/clients/c1?x=1#y')
  })
  it('leaves files, APIs, downloads and other origins to the system', () => {
    expect(inAppHref(a('https://www.prodigyflo.ai/api/documents/d1/file'), origin)).toBeNull()
    expect(inAppHref(a('https://www.prodigyflo.ai/reports/q3.pdf'), origin)).toBeNull()
    expect(inAppHref(a('https://www.prodigyflo.ai/clients/c1', true), origin)).toBeNull()
    expect(inAppHref(a('https://prodigyflo.ai/clients/c1'), origin)).toBeNull()
    expect(inAppHref(a('https://meet.google.com/abc'), origin)).toBeNull()
  })
})

describe('install how-to platform', () => {
  it('tells iPad (desktop user agent) apart by touch points, and Chrome on iOS by CriOS', () => {
    const iPadOS = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
    expect(detectPlatform(iPadOS, 5)).toBe('ios-safari')
    expect(detectPlatform(iPadOS, 0)).toBe('desktop')
    expect(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1', 5)).toBe('ios-chrome')
    expect(detectPlatform('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0 Mobile Safari/537.36', 5)).toBe('android')
  })
})

describe('auth redirects stay on the current host', () => {
  it('turns same-origin absolute urls into paths and refuses other hosts', async () => {
    const { sameSitePath } = await import('@/lib/auth')
    const base = 'https://www.prodigyflo.ai'
    expect(sameSitePath('/call-center?s=today', base)).toBe('/call-center?s=today')
    expect(sameSitePath('https://www.prodigyflo.ai/login?x=1', base)).toBe('/login?x=1')
    expect(sameSitePath('https://evil.example/login', base)).toBe('/')
    expect(sameSitePath('//evil.example/x', base)).toBe('/')
    expect(sameSitePath('/\\evil.example', base)).toBe('/')
    expect(sameSitePath('/', base)).toBe('/')
  })
})
