import Link from 'next/link'
import { AlertCircle, AlertTriangle, ArrowRight, Info, Sparkles } from 'lucide-react'
import { requireUser } from '@/lib/rbac'
import { LEVEL_LABEL, requireAnalyticsLevel } from '@/lib/reporting'
import { getAttentionItems, type AttentionItem, type AttentionSeverity } from '@/lib/attention'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { CollapsibleSection } from '@/components/ui/collapsible-section'
import { number } from '@/lib/format'
import { cn } from '@/lib/utils'

export const metadata = { title: 'Attention' }

// Semantic severity styling — never the brand accent. Info reads as a neutral
// "watch", so critical/warning stay unambiguous when they appear.
const SEVERITY_META: Record<
  AttentionSeverity,
  { Icon: typeof AlertCircle; label: string; chip: string; ring: string; accent: string }
> = {
  critical: {
    Icon: AlertCircle,
    label: 'Critical',
    chip: 'bg-danger/10 text-danger',
    ring: 'ring-danger/30',
    accent: 'text-danger',
  },
  warning: {
    Icon: AlertTriangle,
    label: 'Warning',
    chip: 'bg-warning/10 text-warning',
    ring: 'ring-warning/30',
    accent: 'text-warning',
  },
  info: {
    Icon: Info,
    label: 'Watch',
    chip: 'bg-muted text-muted-foreground',
    ring: 'ring-border',
    accent: 'text-muted-foreground',
  },
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const meta = SEVERITY_META[item.severity]
  const Icon = meta.Icon
  return (
    <Link
      href={item.href}
      className={cn(
        'group bg-card shadow-e1 hover:bg-muted/30 flex items-start gap-3 rounded-xl border p-4 ring-1 transition-colors',
        meta.ring,
      )}
    >
      <Icon className={cn('mt-0.5 size-5 shrink-0', meta.accent)} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">{item.title}</h3>
          <span
            className={cn(
              'inline-flex h-5 items-center rounded-full px-2 text-[0.625rem] font-semibold tracking-wide uppercase',
              meta.chip,
            )}
          >
            {meta.label}
          </span>
          {typeof item.count === 'number' && (
            <span className="text-muted-foreground text-xs tabular-nums">{number(item.count)}</span>
          )}
        </div>
        <p className="text-muted-foreground mt-1 text-sm">{item.detail}</p>
      </div>
      <span className="text-muted-foreground group-hover:text-foreground mt-0.5 inline-flex shrink-0 items-center gap-1 text-xs font-medium transition-colors">
        Act <ArrowRight className="size-3.5" />
      </span>
    </Link>
  )
}

export default async function AttentionPage() {
  const user = await requireUser()
  // Managers+ only — mirrors the reporting/performance gate (redirects otherwise).
  const level = requireAnalyticsLevel(user)
  const items = await getAttentionItems(user)

  const bands: { severity: AttentionSeverity; items: AttentionItem[] }[] = (
    ['critical', 'warning', 'info'] as AttentionSeverity[]
  )
    .map((severity) => ({ severity, items: items.filter((i) => i.severity === severity) }))
    .filter((b) => b.items.length > 0)

  return (
    <>
      <PageHeader
        title="Attention"
        description={`Today's decision list for ${LEVEL_LABEL[level]} — the metrics that have drifted off-target, loudest first`}
        actions={
          items.length > 0 ? (
            <Badge variant="outline" className="tabular-nums">
              {number(items.length)} {items.length === 1 ? 'item' : 'items'}
            </Badge>
          ) : undefined
        }
      />

      <div className="space-y-4 p-4 sm:p-6">
        {items.length === 0 ? (
          <div className="border-success/30 bg-success/5 flex flex-col items-center gap-3 rounded-xl border p-10 text-center">
            <span className="bg-success/15 text-success flex size-12 shrink-0 items-center justify-center rounded-full">
              <Sparkles className="size-6" />
            </span>
            <div>
              <p className="text-success text-base font-semibold">
                Nothing needs attention — the book is healthy.
              </p>
              <p className="text-muted-foreground mt-1 max-w-md text-sm">
                Leakage, close rate, brief adoption, follow-ups, SLAs, qualifier coverage, data
                hygiene and closer activity are all on target across {LEVEL_LABEL[level]}. Keep the
                daily rhythm and this stays clear.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            {bands.map((band) => {
              const meta = SEVERITY_META[band.severity]
              return (
                <CollapsibleSection
                  key={band.severity}
                  storageKey={`attention-${band.severity}`}
                  // Info items are a "watch" list — start them folded so the
                  // loud severities own the first screen.
                  defaultOpen={band.severity !== 'info'}
                  title={
                    <span className="flex items-center gap-1.5">
                      <meta.Icon className={cn('size-4', meta.accent)} />
                      {meta.label}
                    </span>
                  }
                  summary={`${number(band.items.length)} ${band.items.length === 1 ? 'item' : 'items'}`}
                >
                  <div className="space-y-3">
                    {band.items.map((item) => (
                      <AttentionRow key={item.key} item={item} />
                    ))}
                  </div>
                </CollapsibleSection>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
