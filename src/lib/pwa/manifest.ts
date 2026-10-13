import { APP_CHROME, APP_PAPER } from './app-chrome'

/**
 * The web app manifest for one account's branding (served by
 * src/app/manifest/[slug]/route.ts). Pure so tests can pin every field.
 *
 * - `id` is '/' on purpose: manifests shipped before this one had no id, which
 *   browsers read as the start_url '/'. Keeping it lets Android update apps
 *   that are already installed (new start_url, shortcuts) instead of treating
 *   this as a different app.
 * - `start_url` is the `/app` launcher: one 307 to the role's home (the
 *   Call Center for the desk), no page in between. Launch targets can change
 *   later without anyone reinstalling.
 * - `orientation: 'any'`: iPads rotate, and the dialer works both ways.
 * - `display_override` stays plain standalone. window-controls-overlay would
 *   draw the desk header under the desktop title bar, which it does not expect.
 */
export type ManifestBrand = { name: string; shortName: string; iconDir: string }

export const APP_SHORTCUTS = [
  { id: 'today', name: 'Today', description: "Today's calls and follow-ups", url: '/call-center?s=today' },
  { id: 'dialer', name: 'Dialer', description: 'Open the keypad', url: '/call-center?pad=1' },
  { id: 'messages', name: 'Messages', description: 'Texts and team chat', url: '/call-center?s=messages' },
  { id: 'leads', name: 'Leads', description: 'Every lead on the desk', url: '/call-center?s=leads' },
] as const

export function buildManifest(brand: ManifestBrand) {
  const dir = `/brand/${brand.iconDir}`
  return {
    id: '/',
    name: brand.name,
    short_name: brand.shortName,
    description: 'Call, text and follow up with every lead from one app.',
    lang: 'en-US',
    dir: 'ltr',
    start_url: '/app',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone'],
    orientation: 'any',
    theme_color: APP_CHROME,
    background_color: APP_PAPER,
    categories: ['business', 'productivity'],
    prefer_related_applications: false,
    // A second launch (a shortcut, a notification, a shared link) reuses the open window.
    launch_handler: { client_mode: ['navigate-existing', 'auto'] },
    icons: [
      { src: `${dir}/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${dir}/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      // Android masks whatever it is given to the launcher's shape. A rounded
      // tile fed into that gets its corners clipped twice and comes out
      // visibly dented, so `maskable` is a separate full-bleed drawing whose
      // mark sits inside the 80% safe area.
      { src: `${dir}/icon-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: APP_SHORTCUTS.map((s) => ({
      name: s.name,
      short_name: s.name,
      description: s.description,
      url: s.url,
      icons: [{ src: `/pwa/shortcut-${s.id}.png`, sizes: '192x192', type: 'image/png' }],
    })),
  }
}
