import type { Metadata } from 'next'
import { requireUser } from '@/lib/rbac'
import { RecoveryWordmark } from './_components/brand'
import { RecoveryNav } from './_components/nav'

/**
 * Lead Recovery Flow — a separately branded, investor-facing shell that lives
 * inside ProdigyFlo but shows NONE of its chrome. Its own top bar, its own name,
 * and a recovery-green palette scoped entirely to `.rec-shell` (the global theme
 * is never touched). Auth is the same requireUser() gate as the rest of the app.
 */
export const metadata: Metadata = {
  title: { default: 'Lead Recovery Flow', template: '%s · Lead Recovery Flow' },
  description: 'Recover the revenue you already paid to acquire — recycle stalled leads and close them.',
}

// Palette scoped to this shell only. Light values on `.rec-shell`; dark values
// re-picked against a dark ground under `.dark .rec-shell` (not an inversion).
const SCOPED_TOKENS = `
.rec-shell {
  --rec-primary: #0aa06a;
  --rec-primary-ink: #067a52;
  --rec-primary-strong: #0f9d6e;
  --rec-on-primary: #ffffff;
  --rec-primary-soft: #e8f7f0;
  --rec-primary-border: #bfe8d7;
  --rec-ground: #f6f8f5;
  --rec-surface: #ffffff;
  --rec-surface-2: #fbfbf8;
  --rec-border: #e6e7e0;
  --rec-text: #1a2b23;
  --rec-muted: #61726a;
  --rec-amber: #a86a12;
  background: var(--rec-ground);
  color: var(--rec-text);
}
.dark .rec-shell {
  --rec-primary: #2bb583;
  --rec-primary-ink: #56d4a4;
  --rec-primary-strong: #34c48f;
  --rec-on-primary: #04241a;
  --rec-primary-soft: rgba(43,181,131,0.12);
  --rec-primary-border: rgba(43,181,131,0.30);
  --rec-ground: #0c1310;
  --rec-surface: #131d18;
  --rec-surface-2: #16221c;
  --rec-border: #223029;
  --rec-text: #e7efe9;
  --rec-muted: #91a89c;
  --rec-amber: #e0b25a;
}
`

export default async function RecoveryLayout({ children }: LayoutProps<'/'>) {
  await requireUser()

  return (
    <div className="rec-shell min-h-screen">
      <style>{SCOPED_TOKENS}</style>
      <header className="sticky top-0 z-20 border-b border-[var(--rec-border)] bg-[color-mix(in_srgb,var(--rec-surface)_88%,transparent)] backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:px-6 md:flex-row md:items-center md:justify-between">
          <RecoveryWordmark />
          <RecoveryNav />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  )
}
