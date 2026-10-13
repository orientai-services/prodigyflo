import type { Metadata, Viewport } from 'next'
import { Fraunces, Geist, Geist_Mono, IBM_Plex_Sans } from 'next/font/google'
import { DEFAULT_BRAND } from '@/components/brand/org-brand'
import { GoogleTagManagerNoScript, GoogleTagManagerScript } from '@/components/analytics/google-tag-manager'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { InstalledAppRuntime } from '@/components/pwa/installed-app-runtime'
import { APP_VIEWPORT, installedAppMetadata } from '@/lib/pwa/app-chrome'
import './globals.css'

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] })
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })
const ibmPlex = IBM_Plex_Sans({
  variable: '--font-ibm-plex',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
})
const fraunces = Fraunces({
  variable: '--font-fraunces',
  subsets: ['latin'],
  weight: ['500', '600'],
})

// The agency's icons and manifest ride on every page, including sign-in and
// /forbidden, which sit outside the (app) layout. Without them, "Add to Home
// Screen" from those pages gave iOS a page screenshot instead of the mark.
// The (app) layout swaps in the active account's own set once signed in.
export const metadata: Metadata = {
  title: { default: 'ProdigyFlo', template: '%s · ProdigyFlo' },
  description: 'Sales Client Overview — survey to submission, in one system.',
  applicationName: DEFAULT_BRAND.name,
  manifest: `/manifest/${DEFAULT_BRAND.iconDir}`,
  // Standalone launch, black-translucent status bar, startup images and
  // icons, on every page (sign-in included): see src/lib/pwa/app-chrome.ts.
  ...installedAppMetadata(DEFAULT_BRAND),
}

export const viewport: Viewport = APP_VIEWPORT

// Applies the stored theme and desktop-sidebar state before first paint so
// neither ever flashes (see src/components/layout/sidebar-state.ts).
const themeScript = `
try {
  var t = localStorage.getItem('pf-theme');
  var d = window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (t === 'dark' || (!t && d)) document.documentElement.classList.add('dark');
  if (localStorage.getItem('pf-sidebar') === 'expanded') document.documentElement.classList.add('pf-nav-open');
} catch (e) {}
try {
  if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true) document.documentElement.classList.add('pf-standalone');
} catch (e) {}
// Chrome fires its one install prompt whenever it likes, often before React
// hydrates; park it for the "Install app" button (src/components/pwa/install-store.ts).
window.addEventListener('beforeinstallprompt', function (e) { window.__pfInstall = e; });
`

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${ibmPlex.variable} ${fraunces.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <GoogleTagManagerScript />
      </head>
      <body className="bg-background text-foreground min-h-full">
        <GoogleTagManagerNoScript />
        {/* Paints the status-bar strip of an installed iPhone/iPad app (black-translucent text is always white). */}
        <div className="pf-status-band" aria-hidden="true" />
        <TooltipProvider delay={200}>{children}</TooltipProvider>
        {/* Below the status bar / notch of an edge-to-edge installed app. */}
        <Toaster
          richColors
          closeButton
          position="top-right"
          offset={{ top: 'calc(env(safe-area-inset-top) + 16px)', right: 'calc(env(safe-area-inset-right) + 16px)' }}
          mobileOffset={{ top: 'calc(env(safe-area-inset-top) + 12px)', left: 'calc(env(safe-area-inset-left) + 12px)', right: 'calc(env(safe-area-inset-right) + 12px)' }}
        />
        <InstalledAppRuntime />
      </body>
    </html>
  )
}
