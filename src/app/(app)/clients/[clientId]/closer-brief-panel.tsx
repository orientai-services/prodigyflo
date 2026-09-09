'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Loader2,
  MessageCircleQuestion,
  NotebookPen,
  Sparkles,
  Target,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { BriefView } from '@/lib/ai/closeops-ai'
import { generateBriefAction, markBriefViewedAction } from './closeops-actions'

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-muted-foreground mb-1.5 text-[0.6875rem] font-semibold uppercase tracking-[0.06em]">{children}</p>
  )
}

function BriefBody({ brief }: { brief: BriefView }) {
  const c = brief.content
  return (
    <div className="space-y-4 pt-3">
      {c.situation && (
        <div>
          <SectionLabel>Situation</SectionLabel>
          <p className="text-sm leading-relaxed">{c.situation}</p>
        </div>
      )}

      {c.highlights.length > 0 && (
        <div>
          <SectionLabel>Highlights</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {c.highlights.map((h) => (
              <span key={h} className="bg-surface-sunk rounded-md border px-2 py-0.5 text-xs">
                {h}
              </span>
            ))}
          </div>
        </div>
      )}

      {c.objections.length > 0 && (
        <div>
          <SectionLabel>Likely objections</SectionLabel>
          <ul className="space-y-2.5">
            {c.objections.map((o) => (
              <li key={o.objection} className="text-sm">
                <p className="flex items-start gap-1.5 font-medium">
                  <MessageCircleQuestion className="text-warning mt-0.5 size-3.5 shrink-0" />
                  {o.objection}
                </p>
                <p className="text-muted-foreground mt-0.5 pl-5 text-xs leading-relaxed">{o.response}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {c.redline && c.redline.length > 0 && (
        <div>
          <SectionLabel>Redline (internal)</SectionLabel>
          <ul className="space-y-1">
            {c.redline.map((t) => (
              <li key={t} className="text-sm leading-relaxed">
                {t}
              </li>
            ))}
          </ul>
        </div>
      )}

      {c.cancelPath && c.cancelPath.length > 0 && (
        <div>
          <SectionLabel>Best-probability path</SectionLabel>
          <ul className="space-y-1">
            {c.cancelPath.map((t) => (
              <li key={t} className="text-sm leading-relaxed">
                {t}
              </li>
            ))}
          </ul>
        </div>
      )}

      {c.outcomeCeiling && (
        <div>
          <SectionLabel>Outcome ceiling</SectionLabel>
          <p className="text-sm leading-relaxed">{c.outcomeCeiling}</p>
        </div>
      )}

      {c.closeTalk && (
        <div>
          <SectionLabel>Close talk</SectionLabel>
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{c.closeTalk}</p>
        </div>
      )}

      {c.talkingPoints.length > 0 && (
        <div>
          <SectionLabel>Talking points</SectionLabel>
          <ul className="space-y-1">
            {c.talkingPoints.map((t) => (
              <li key={t} className="flex items-start gap-1.5 text-sm">
                <NotebookPen className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
                {t}
              </li>
            ))}
          </ul>
        </div>
      )}

      {c.recommendedNextStep && (
        <div className="border-primary/30 bg-primary/5 flex items-start gap-2 rounded-md border px-3 py-2">
          <Target className="text-primary mt-0.5 size-4 shrink-0" />
          <div>
            <p className="text-xs font-semibold">Recommended next step</p>
            <p className="text-muted-foreground text-sm">{c.recommendedNextStep}</p>
          </div>
        </div>
      )}
    </div>
  )
}

function ViewedBadge({ brief }: { brief: BriefView }) {
  return brief.viewedAt ? (
    <span
      className="text-success inline-flex items-center gap-1 text-[0.6875rem]"
      title={brief.viewedByName ? `First opened by ${brief.viewedByName}` : undefined}
    >
      <Eye className="size-3" />
      Viewed {relativeTime(brief.viewedAt)}
    </span>
  ) : (
    <span className="text-warning inline-flex items-center gap-1 text-[0.6875rem]">
      <EyeOff className="size-3" />
      Not opened yet
    </span>
  )
}

/**
 * The pre-call Closer Brief panel. Opening a brief is what marks it viewed —
 * that timestamp is the adoption signal the phase dashboards measure, so it is
 * recorded only on a genuine open, never on page load.
 */
export function CloserBriefPanel({
  clientId,
  canRun,
  mock,
  modelLabel,
  briefs,
}: {
  clientId: string
  canRun: boolean
  mock: boolean
  modelLabel: string | null
  briefs: BriefView[]
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [generating, setGenerating] = useState(false)
  const [fresh, setFresh] = useState<BriefView | null>(null)
  const [openIds, setOpenIds] = useState<Set<string>>(new Set())
  const [markedIds, setMarkedIds] = useState<Set<string>>(new Set())

  // A brief generated this session leads the list until the refresh lands.
  const all = useMemo(() => {
    if (!fresh) return briefs
    return [fresh, ...briefs.filter((b) => b.id !== fresh.id)]
  }, [fresh, briefs])
  const latest = all[0] ?? null
  const previous = all.slice(1)

  const markViewed = (brief: BriefView) => {
    if (brief.viewedAt || markedIds.has(brief.id)) return
    setMarkedIds((prev) => new Set(prev).add(brief.id))
    startTransition(async () => {
      try {
        await markBriefViewedAction({ clientId, briefId: brief.id })
        router.refresh()
      } catch {
        // A failed view-mark never blocks reading the brief.
      }
    })
  }

  const toggle = (brief: BriefView) => {
    setOpenIds((prev) => {
      const next = new Set(prev)
      if (next.has(brief.id)) {
        next.delete(brief.id)
      } else {
        next.add(brief.id)
        markViewed(brief) // genuinely on view: content becomes visible right now
      }
      return next
    })
  }

  const generate = () => {
    setGenerating(true)
    startTransition(async () => {
      try {
        const result = await generateBriefAction({ clientId })
        if (result.ok) {
          setFresh(result.brief)
          // The requester reads it immediately — open it and record the view.
          setOpenIds((prev) => new Set(prev).add(result.brief.id))
          markViewed(result.brief)
          toast.success('Closer Brief ready')
          router.refresh()
        } else {
          toast.error(result.error)
        }
      } catch {
        toast.error('The brief could not be generated. Try again in a moment.')
      } finally {
        setGenerating(false)
      }
    })
  }

  return (
    <section className="bg-card shadow-e1 rounded-lg border">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Sparkles className="text-primary size-4" />
        <h3 className="text-sm font-medium">Closer Brief</h3>
        {mock ? (
          <Badge variant="outline" title="No AI key is configured, so a deterministic sample model runs. Results are illustrative.">
            Demo mode
          </Badge>
        ) : (
          modelLabel && (
            <Badge variant="outline" className="text-muted-foreground">
              {modelLabel}
            </Badge>
          )
        )}
        <p className="text-muted-foreground w-full text-xs sm:ml-auto sm:w-auto">
          Pre-call prep from this file only. AI signal — humans decide.
        </p>
      </header>

      <div className="space-y-3 p-4">
        {canRun && (
          <div className="flex items-center gap-2">
            <Button variant={latest ? 'outline' : 'default'} size="sm" disabled={generating} onClick={generate}>
              {generating ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
              {latest ? 'Regenerate brief' : 'Generate brief'}
            </Button>
            {latest && (
              <p className="text-muted-foreground text-xs">
                Regenerating creates a new brief from the file as it stands now.
              </p>
            )}
          </div>
        )}

        {!latest && (
          <p className="bg-surface-sunk/50 text-muted-foreground rounded-md border border-dashed px-3 py-4 text-center text-xs">
            {canRun
              ? 'No brief yet. Generate one before the call — situation, highlights, likely objections, and the recommended next step.'
              : 'No brief has been generated for this client yet.'}
          </p>
        )}

        {latest && (
          <article className="bg-surface-raised/40 rounded-lg border p-3">
            <button
              type="button"
              className="flex w-full flex-wrap items-center gap-2 text-left"
              aria-expanded={openIds.has(latest.id)}
              onClick={() => toggle(latest)}
            >
              {openIds.has(latest.id) ? (
                <ChevronDown className="text-muted-foreground size-4 shrink-0" />
              ) : (
                <ChevronRight className="text-muted-foreground size-4 shrink-0" />
              )}
              <span className="text-sm font-medium">Latest brief</span>
              <Badge variant="secondary" className="text-[0.625rem]">
                {relativeTime(latest.generatedAt)}
              </Badge>
              <ViewedBadge brief={latest} />
              <span className="text-muted-foreground ml-auto text-[0.6875rem]">
                {latest.provider === 'mock' ? 'sample model' : (latest.model ?? latest.provider)}
                {latest.requestedByName ? ` · requested by ${latest.requestedByName}` : ''}
              </span>
            </button>
            {openIds.has(latest.id) && <BriefBody brief={latest} />}
          </article>
        )}

        {previous.length > 0 && (
          <div className="border-t pt-2">
            <SectionLabel>
              Previous brief{previous.length === 1 ? '' : 's'} ({previous.length})
            </SectionLabel>
            <ul className="space-y-1.5">
              {previous.map((b) => (
                <li key={b.id} className={cn('rounded-md border', openIds.has(b.id) ? 'bg-surface-raised/40 p-3' : 'px-3 py-1.5')}>
                  <button
                    type="button"
                    className="flex w-full flex-wrap items-center gap-2 text-left text-xs"
                    aria-expanded={openIds.has(b.id)}
                    onClick={() => toggle(b)}
                  >
                    {openIds.has(b.id) ? (
                      <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
                    ) : (
                      <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
                    )}
                    <span className="text-foreground">{relativeTime(b.generatedAt)}</span>
                    <ViewedBadge brief={b} />
                    <span className="text-muted-foreground ml-auto text-[0.6875rem]">
                      {b.provider === 'mock' ? 'sample model' : (b.model ?? b.provider)}
                    </span>
                  </button>
                  {openIds.has(b.id) && <BriefBody brief={b} />}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}
