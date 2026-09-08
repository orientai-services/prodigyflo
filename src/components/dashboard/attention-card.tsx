import Link from 'next/link'
import { AlertCircle, AlertTriangle, ArrowRight, Info, ShieldCheck } from 'lucide-react'
import type { SessionUser } from '@/lib/rbac'
import { analyticsLevel } from '@/lib/reporting'
import { getAttentionItems, type AttentionItem, type AttentionSeverity } from '@/lib/attention'
import { number } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Compact dashboard surface of the Attention feed — top items + a link to /attention. */

const DOT_ICON: Record<AttentionSeverity, typeof AlertCircle> = {
  critical: AlertCircle,
  warning: AlertTriangle,
  info: Info,
}

const DOT_ACCENT: Record<AttentionSeverity, string> = {
  critical: 'text-danger',
  warning: 'text-warning',
  info: 'text-muted-foreground',
}

const PREVIEW_LIMIT = 4

export async function AttentionCard({
  user,
  items: preloaded,
  hideHeader = false,
}: {
  user: SessionUser
  /** Pre-fetched items (already user-scoped) — avoids a duplicate query when the page needs the count itself. */
  items?: AttentionItem[]
  /** Skip the card's own header when an outer section already labels it. */
  hideHeader?: boolean
}) {
  // Re-check access here — this is a public-facing async component, never rely
  // on the page that renders it. Managers+ (any wider-than-self analytics) only.
  if (!analyticsLevel(user)) return null

  const items = preloaded ?? (await getAttentionItems(user))
  const top = items.slice(0, PREVIEW_LIMIT)
  const remaining = items.length - top.length

  return (
    <section className="bg-card rounded-lg border">
      {!hideHeader && (
        <header className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h2 className="text-sm font-medium">Needs attention</h2>
            <p className="text-muted-foreground mt-0.5 text-xs">
              What has drifted off-target across your book
            </p>
          </div>
          {items.length > 0 && (
            <span className="bg-muted text-foreground inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums">
              {number(items.length)}
            </span>
          )}
        </header>
      )}

      {items.length === 0 ? (
        <div className="flex items-center gap-3 px-4 py-5">
          <span className="bg-success/15 text-success flex size-9 shrink-0 items-center justify-center rounded-full">
            <ShieldCheck className="size-4.5" />
          </span>
          <div>
            <p className="text-success text-sm font-medium">The book is healthy.</p>
            <p className="text-muted-foreground text-xs">
              Nothing needs attention right now — every operating metric is on target.
            </p>
          </div>
        </div>
      ) : (
        <ul className="divide-y">
          {top.map((item) => {
            const Icon = DOT_ICON[item.severity]
            return (
              <li key={item.key}>
                <Link
                  href={item.href}
                  className="hover:bg-muted/40 flex items-start gap-2.5 px-4 py-2.5 transition-colors"
                >
                  <Icon className={cn('mt-0.5 size-4 shrink-0', DOT_ACCENT[item.severity])} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.title}</p>
                    <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">{item.detail}</p>
                  </div>
                  {typeof item.count === 'number' && (
                    <span className="text-muted-foreground shrink-0 text-xs font-medium tabular-nums">
                      {number(item.count)}
                    </span>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      )}

      <footer className="border-t px-4 py-2.5">
        <Link
          href="/attention"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs font-medium transition-colors"
        >
          {remaining > 0 ? `View all — ${number(remaining)} more` : 'View all attention'}
          <ArrowRight className="size-3.5" />
        </Link>
      </footer>
    </section>
  )
}
