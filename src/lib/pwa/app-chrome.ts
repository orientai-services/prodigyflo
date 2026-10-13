import type { Metadata, Viewport } from 'next'

/**
 * The installed app's platform chrome (docs/MOBILE.md "Installed app"): the
 * status bar, the theme colour, the iOS startup images and the home-screen
 * icons. One module so the root layout, the (app) layout and the manifest
 * cannot drift apart.
 *
 * WHY black-translucent + a painted band. iOS gives a home-screen app three
 * status-bar styles; only `black-translucent` lets the page run edge to edge
 * (safe-area-inset-top becomes the real notch / Dynamic Island height), which
 * is what makes it look like an app instead of a web page in a frame. Its
 * text is always white, so globals.css paints the inset strip in the desk navy
 * (`.pf-status-band`); without it the white clock would sit on the cream
 * Call Center header and disappear.
 */

/** The desk navy: the phone top bar, the status band, Android's status bar. */
export const APP_CHROME = '#12202c'
/** Slightly deeper for dark mode, so the bar does not glow above a dark page. */
export const APP_CHROME_DARK = '#0b151d'
/** The desk paper: what the first frame of the app paints. */
export const APP_PAPER = '#faf7f0'

export const APP_THEME_COLORS: NonNullable<Viewport['themeColor']> = [
  { media: '(prefers-color-scheme: light)', color: APP_CHROME },
  { media: '(prefers-color-scheme: dark)', color: APP_CHROME_DARK },
]

/**
 * Every page: edge to edge (`viewport-fit=cover`, without it the insets read
 * 0), the navy chrome in both colour schemes. Zoom stays allowed; inputs are
 * kept at 16 px instead (globals.css), which is what stops iOS zooming on focus.
 */
export const APP_VIEWPORT: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: APP_THEME_COLORS,
}

/**
 * iOS startup images: Safari shows one only when its media query matches the
 * device EXACTLY (CSS size, pixel ratio, orientation, colour scheme), so each
 * current iPhone and iPad size is listed. `device-width`/`device-height` are
 * always the portrait numbers, in either orientation.
 * [css width, css height, pixel ratio, devices]
 */
export const SPLASH_DEVICES: readonly (readonly [number, number, number, string])[] = [
  [440, 956, 3, 'iPhone 16 Pro Max, 17 Pro Max'],
  [430, 932, 3, 'iPhone 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus'],
  [420, 912, 3, 'iPhone Air'],
  [402, 874, 3, 'iPhone 16 Pro, 17, 17 Pro'],
  [393, 852, 3, 'iPhone 14 Pro, 15, 15 Pro, 16'],
  [390, 844, 3, 'iPhone 12, 13, 14, 16e'],
  [428, 926, 3, 'iPhone 12 Pro Max, 13 Pro Max, 14 Plus'],
  [375, 812, 3, 'iPhone X, XS, 11 Pro, 12 mini, 13 mini'],
  [414, 896, 3, 'iPhone XS Max, 11 Pro Max'],
  [414, 896, 2, 'iPhone XR, 11'],
  [375, 667, 2, 'iPhone SE (2nd, 3rd), 8'],
  [1032, 1376, 2, 'iPad Pro 13 (M4, M5)'],
  [1024, 1366, 2, 'iPad Pro 12.9, iPad Air 13'],
  [834, 1210, 2, 'iPad Pro 11 (M4, M5)'],
  [834, 1194, 2, 'iPad Pro 11'],
  [820, 1180, 2, 'iPad Air 10.9 / 11, iPad (10th, 11th)'],
  [834, 1112, 2, 'iPad Pro 10.5, iPad Air (3rd)'],
  [810, 1080, 2, 'iPad (7th, 8th, 9th)'],
  [744, 1133, 2, 'iPad mini (6th, 7th)'],
  [768, 1024, 2, 'iPad mini (5th), iPad (6th) and older'],
]

export type SplashTheme = 'light' | 'dark'
export type SplashImage = { file: string; width: number; height: number; dpr: number; theme: SplashTheme; media: string }

/** The pixel-exact images, both orientations and both colour schemes. */
export function splashImages(): SplashImage[] {
  const out: SplashImage[] = []
  for (const [w, h, dpr] of SPLASH_DEVICES) {
    for (const orientation of ['portrait', 'landscape'] as const) {
      const [pw, ph] = orientation === 'portrait' ? [w * dpr, h * dpr] : [h * dpr, w * dpr]
      for (const theme of ['light', 'dark'] as const) {
        out.push({
          file: `${pw}x${ph}-${theme}.png`,
          width: pw,
          height: ph,
          dpr,
          theme,
          media:
            `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr})` +
            ` and (orientation: ${orientation}) and (prefers-color-scheme: ${theme})`,
        })
      }
    }
  }
  return out
}

/** Parses a splash file name; null for anything not in the list (the route 404s). */
export function splashFor(file: string): SplashImage | null {
  return splashImages().find((s) => s.file === file) ?? null
}

/**
 * Home-screen identity for one account: the iOS metadata (standalone, status
 * bar, startup images, icons) that both layouts emit.
 *
 * `apple-mobile-web-app-capable` is written by hand: Next 16 emits only the
 * standards `mobile-web-app-capable` for `appleWebApp.capable`, and iOS before
 * 17.4 (and any page Safari saves without reading the manifest) needs the
 * Apple name to open the icon without Safari's toolbars.
 */
export function installedAppMetadata(brand: { shortName: string; iconDir: string }): Metadata {
  const dir = `/brand/${brand.iconDir}`
  return {
    appleWebApp: {
      capable: true,
      title: brand.shortName,
      statusBarStyle: 'black-translucent',
      startupImage: splashImages().map((s) => ({ url: `/splash/${brand.iconDir}/${s.file}`, media: s.media })),
    },
    other: { 'apple-mobile-web-app-capable': 'yes' },
    // Phone numbers, dates and addresses render as written; real tel: links still dial.
    formatDetection: { telephone: false, date: false, address: false, email: false },
    icons: {
      apple: [
        { url: `${dir}/apple-touch-icon.png`, sizes: '180x180' },
        { url: `${dir}/apple-touch-icon-167.png`, sizes: '167x167' },
        { url: `${dir}/apple-touch-icon-152.png`, sizes: '152x152' },
      ],
      icon: [{ url: `${dir}/icon-192.png`, sizes: '192x192', type: 'image/png' }],
    },
  }
}
