import { brandFor, BRANDED_SLUGS } from '@/components/brand/org-brand'

/**
 * Per-account PWA manifest: `/manifest/<slug>`.
 *
 * WHY A SLUG IN THE PATH INSTEAD OF ONE COOKIE-AWARE `/manifest.webmanifest`.
 * The browser fetches a manifest with `crossorigin="anonymous"` unless the link
 * says otherwise, so a single dynamic manifest would be requested WITHOUT the
 * session cookie and could never know which account is active. It would install
 * as ProdigyFlo every time, silently, and only on a real device. Putting the
 * account in the URL removes the question: the server already knows the active
 * account when it renders the `<link>`, so the manifest itself is static,
 * cacheable, and correct.
 *
 * Unknown slugs fall back to the agency's branding rather than 404ing — a
 * missing manifest downgrades an installed app with no visible cause.
 *
 * Note this does NOT cover iOS: Safari ignores manifest icons for Add to Home
 * Screen and uses `<link rel="apple-touch-icon">`, which (app)/layout.tsx sets
 * from the same registry. Both have to move together.
 */
export function generateStaticParams() {
  return BRANDED_SLUGS.map((slug) => ({ slug }))
}

export async function GET(_req: Request, ctx: RouteContext<'/manifest/[slug]'>) {
  const { slug } = await ctx.params
  const brand = brandFor(slug)

  return Response.json(
    {
      name: brand.name,
      short_name: brand.shortName,
      start_url: '/dashboard',
      scope: '/',
      display: 'standalone',
      theme_color: brand.themeColor,
      background_color: brand.backgroundColor,
      icons: [
        {
          src: `/brand/${brand.iconDir}/icon-192.png`,
          sizes: '192x192',
          type: 'image/png',
          purpose: 'any',
        },
        {
          src: `/brand/${brand.iconDir}/icon-512.png`,
          sizes: '512x512',
          type: 'image/png',
          purpose: 'any',
        },
        // Android masks whatever it is given to the launcher's shape. A rounded
        // tile fed into that gets its corners clipped twice and comes out
        // visibly dented, so `maskable` is a separate full-bleed drawing whose
        // mark sits inside the 80% safe area.
        {
          src: `/brand/${brand.iconDir}/icon-maskable-512.png`,
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable',
        },
      ],
    },
    { headers: { 'content-type': 'application/manifest+json' } },
  )
}
