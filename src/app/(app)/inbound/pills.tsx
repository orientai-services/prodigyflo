import type { InboundCategory } from '@prisma/client'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/**
 * CATEGORY colors are a categorical system — one distinct hue per kind of thing
 * that arrived. They deliberately avoid the success/warning/danger severity
 * palette so "a document arrived" never reads as "something is wrong".
 */
const CATEGORY_META: Record<InboundCategory, { label: string; className: string; glyph: string }> = {
  CONTACT: { label: 'Contact', glyph: '👤', className: 'bg-sky-500/10 text-sky-700 dark:text-sky-400' },
  DOCUMENT: { label: 'Document', glyph: '📄', className: 'bg-violet-500/10 text-violet-700 dark:text-violet-400' },
  OPPORTUNITY: { label: 'Opportunity', glyph: '🎯', className: 'bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-400' },
  NOTE: { label: 'Note', glyph: '📝', className: 'bg-slate-500/10 text-slate-700 dark:text-slate-300' },
  APPOINTMENT: { label: 'Appointment', glyph: '📅', className: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-400' },
  OTHER: { label: 'Other', glyph: '•', className: 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-400' },
}

export const INBOUND_CATEGORIES: InboundCategory[] = [
  'CONTACT',
  'DOCUMENT',
  'OPPORTUNITY',
  'NOTE',
  'APPOINTMENT',
  'OTHER',
]

export function categoryLabel(category: InboundCategory): string {
  return CATEGORY_META[category].label
}

export function categoryAccent(category: InboundCategory): string {
  return CATEGORY_META[category].className
}

export function CategoryPill({ category, className }: { category: InboundCategory; className?: string }) {
  const meta = CATEGORY_META[category]
  return (
    <Badge variant="secondary" className={cn(meta.className, 'font-medium', className)}>
      {meta.label}
    </Badge>
  )
}

/**
 * DOCUMENT-STATUS colors ARE semantic — an inbound doc-status feed uses free-form
 * strings, so the map is tolerant: it normalizes and keyword-matches, always
 * degrading to a neutral pill rather than throwing on an unknown status.
 */
const STATUS_RULES: { test: RegExp; className: string }[] = [
  { test: /(approv|complet|sign|verified|accept|fund|paid|clear)/i, className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
  { test: /(reject|declin|fail|denied|error|cancel|void)/i, className: 'bg-red-500/10 text-red-700 dark:text-red-400' },
  { test: /(review|process|pending.*review|await)/i, className: 'bg-amber-500/10 text-amber-700 dark:text-amber-400' },
  { test: /(missing|incomplet|correction|hold|action)/i, className: 'bg-orange-500/10 text-orange-700 dark:text-orange-400' },
  { test: /(request|pending|new|sent|open)/i, className: 'bg-sky-500/10 text-sky-700 dark:text-sky-400' },
  { test: /(receiv|upload|submit|in)/i, className: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-400' },
  { test: /(expir|stale|archiv)/i, className: 'bg-muted text-muted-foreground' },
]

export function docStatusClasses(status: string): string {
  const s = status.trim()
  for (const rule of STATUS_RULES) if (rule.test.test(s)) return rule.className
  return 'bg-slate-500/10 text-slate-700 dark:text-slate-300'
}

function prettyStatus(status: string): string {
  const s = status.trim().replace(/[_-]+/g, ' ')
  if (!s) return 'Unknown'
  return s.replace(/\b\w/g, (c) => c.toUpperCase())
}

export function DocStatusPill({ status, className }: { status: string; className?: string }) {
  return (
    <Badge variant="secondary" className={cn(docStatusClasses(status), 'font-medium', className)}>
      {prettyStatus(status)}
    </Badge>
  )
}

/** Connector chip: the source that delivered the event, with its catalog glyph. */
export function ConnectorChip({
  glyph,
  name,
  accent,
  className,
}: {
  glyph: string
  name: string
  accent?: string
  className?: string
}) {
  return (
    <span
      className={cn(
        'text-muted-foreground inline-flex max-w-[12rem] items-center gap-1.5 truncate text-xs',
        className,
      )}
    >
      <span
        aria-hidden
        className="inline-flex size-4 shrink-0 items-center justify-center rounded text-[0.625rem]"
        style={accent ? { backgroundColor: `${accent}1a` } : undefined}
      >
        {glyph}
      </span>
      <span className="truncate">{name}</span>
    </span>
  )
}
