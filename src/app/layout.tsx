import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { GoogleTagManagerNoScript, GoogleTagManagerScript } from '@/components/analytics/google-tag-manager'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import './globals.css'

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] })
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })

export const metadata: Metadata = {
  title: { default: 'ProdigyFlo', template: '%s · ProdigyFlo' },
  description: 'Sales Client Overview — survey to submission, in one system.',
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
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
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
