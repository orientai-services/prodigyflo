import type { Metadata } from 'next'
import { Fraunces, Geist, Geist_Mono, IBM_Plex_Sans } from 'next/font/google'
import { DEFAULT_BRAND } from '@/components/brand/org-brand'
import { GoogleTagManagerNoScript, GoogleTagManagerScript } from '@/components/analytics/google-tag-manager'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
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
  appleWebApp: { capable: true, title: DEFAULT_BRAND.shortName, statusBarStyle: 'default' },
  icons: {
    apple: [{ url: `/brand/${DEFAULT_BRAND.iconDir}/apple-touch-icon.png`, sizes: '180x180' }],
    icon: [{ url: `/brand/${DEFAULT_BRAND.iconDir}/icon-192.png`, sizes: '192x192', type: 'image/png' }],
  },
}

// Applies the stored theme and desktop-sidebar state before first paint so
// neither ever flashes (see src/components/layout/sidebar-state.ts).
const themeScript = `
try {
  var t = localStorage.getItem('pf-theme');
  var d = window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (t === 'dark' || (!t && d)) document.documentElement.classList.add('dark');
  if (localStorage.getItem('pf-sidebar') === 'expanded') document.documentElement.classList.add('pf-nav-open');
} catch (e) {}
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
        <TooltipProvider delay={200}>{children}</TooltipProvider>
        <Toaster richColors closeButton position="top-right" />
      </body>
    </html>
  )
}
