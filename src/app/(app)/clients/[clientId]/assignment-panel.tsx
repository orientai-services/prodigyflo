'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  Check,
  Loader2,
  ShieldAlert,
  Sparkles,
  UserCheck,
  Users,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { relativeTime, shortDate } from '@/lib/format'
import type { AssignmentPanelData, AssignmentSuggestionView } from '@/lib/assignment'
import {
  applyCloserAction,
  dismissSuggestionAction,
  loadAssignmentPanelAction,
  suggestCloserAction,
} from './assignment-actions'

/**
 * Closer assignment card — AI suggests, a person decides.
 *
 * Self-contained: fetches its own data through a server action that re-checks
 * scope and permissions, so the page wires it with a single import.
 */

function ConfidenceMeter({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title="Model confidence in this recommendation">
      <span className="bg-surface-sunk inline-block h-1.5 w-16 overflow-hidden rounded-full border">
        <span
          className={`block h-full rounded-full ${value >= 70 ? 'bg-success' : value >= 50 ? 'bg-warning' : 'bg-danger'}`}
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      </span>
      {value}% confidence
    </span>
  )
}

function RankingList({ suggestion }: { suggestion: AssignmentSuggestionView }) {
  if (suggestion.ranking.length === 0) return null
  return (
    <div>
      <p className="text-muted-foreground mb-1 text-[0.6875rem] font-semibold uppercase tracking-[0.06em]">
        Candidates considered
      </p>
      <ul className="space-y-1">
        {suggestion.ranking.map((r) => (
          <li key={r.id} className="flex items-center gap-2 text-xs">
            {r.id === suggestion.recommendedCloserId ? (
              <Check className="text-success size-3 shrink-0" />
            ) : (
              <span className="size-3 shrink-0" />
            )}
            <span className={r.id === suggestion.recommendedCloserId ? 'font-medium' : ''}>{r.name}</span>
            <span className="text-muted-foreground tabular-nums">{r.score} / 100</span>
            {r.disqualifiers.length > 0 && (
              <span className="text-danger inline-flex items-center gap-1" title={r.disqualifiers.join('; ')}>
                <ShieldAlert className="size-3 shrink-0" />
                {r.disqualifiers[0]}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function CloserPicker({
  data,
  value,
  onChange,
  excludeId,
}: {
  data: AssignmentPanelData
  value: string
  onChange: (id: string) => void
  excludeId?: string | null
}) {
  return (
    <NativeSelect size="sm" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Choose a closer">
      <option value="">Choose a closer…</option>
      {data.closers
        .filter((c) => c.id !== excludeId)
        .map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {c.teamName ? ` — ${c.teamName}` : ''} ({c.activeClients}/{c.capacity} active)
          </option>
        ))}
    </NativeSelect>
  )
}

export function AssignmentPanel({ clientId }: { clientId: string }) {
  const router = useRouter()
  const [data, setData] = useState<AssignmentPanelData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'suggest' | 'apply' | 'dismiss' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [overrideOpen, setOverrideOpen] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [pickedId, setPickedId] = useState('')
  const [overrideReason, setOverrideReason] = useState('')
  const [, startTransition] = useTransition()

  const reload = useCallback(async () => {
    const result = await loadAssignmentPanelAction({ clientId })
    if (result.ok) {
      setData(result.data)
      setLoadError(null)
    } else {
      setLoadError(result.error)
    }
  }, [clientId])

  useEffect(() => {
    let cancelled = false
    loadAssignmentPanelAction({ clientId }).then((result) => {
      if (cancelled) return
      if (result.ok) {
        setData(result.data)
        setLoadError(null)
      } else {
        setLoadError(result.error)
      }
    })
    return () => {
      cancelled = true
    }
  }, [clientId])

  const resetChoosers = () => {
    setOverrideOpen(false)
    setManualOpen(false)
    setPickedId('')
    setOverrideReason('')
  }

  const suggest = () => {
    setBusy('suggest')
    setError(null)
    startTransition(async () => {
      try {
        const result = await suggestCloserAction({ clientId })
        if (result.ok) {
          toast.success('Closer suggestion ready for your review')
          await reload()
        } else {
          setError(result.error)
          toast.error(result.error)
        }
      } catch {
        setError('The suggestion could not be generated. Try again in a moment.')
        toast.error('The suggestion could not be generated.')
      } finally {
        setBusy(null)
      }
    })
  }

  const apply = (assigneeId: string, recommendationId?: string, reason?: string) => {
    setBusy('apply')
    setError(null)
    startTransition(async () => {
      try {
        const result = await applyCloserAction({
          clientId,
          assigneeId,
          recommendationId,
          overrideReason: reason?.trim() || undefined,
        })
        if (result.ok) {
          toast.success(
            result.wasOverride
              ? `Assigned ${result.assigneeName} — recorded as an override of the AI pick`
              : `Assigned ${result.assigneeName} as the closer`,
          )
          resetChoosers()
          await reload()
          router.refresh()
        } else {
          setError(result.error)
          toast.error(result.error)
        }
      } catch {
        setError('The assignment could not be saved.')
        toast.error('The assignment could not be saved.')
      } finally {
        setBusy(null)
      }
    })
  }

  const dismiss = (recommendationId: string) => {
    setBusy('dismiss')
    setError(null)
    startTransition(async () => {
      try {
        const result = await dismissSuggestionAction({ clientId, recommendationId })
        if (result.ok) {
          toast.success('Dismissed — no assignment was made')
          resetChoosers()
          await reload()
        } else {
          setError(result.error)
          toast.error(result.error)
        }
      } catch {
        toast.error('The suggestion could not be dismissed.')
      } finally {
        setBusy(null)
      }
    })
  }

  if (loadError) {
    return (
      <section className="bg-card shadow-e1 rounded-lg border p-4">
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <AlertTriangle className="size-3.5 shrink-0" />
          {loadError}
        </p>
      </section>
    )
  }

  if (!data) {
    return (
      <section className="bg-card shadow-e1 rounded-lg border">
        <header className="flex items-center gap-2 border-b px-4 py-3">
          <UserCheck className="text-primary size-4" />
          <h3 className="text-sm font-medium">Closer assignment</h3>
        </header>
        <div className="space-y-3 p-4">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-8 w-40" />
        </div>
      </section>
    )
  }

  const pending = data.pending
  const recommendedInList =
    pending?.recommendedCloserId != null && data.closers.some((c) => c.id === pending.recommendedCloserId)

  return (
    <section className="bg-card shadow-e1 rounded-lg border">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <UserCheck className="text-primary size-4" />
        <h3 className="text-sm font-medium">Closer assignment</h3>
        {data.mock ? (
          <Badge variant="outline" title="No AI key is configured, so a deterministic sample model runs. Results are illustrative.">
            Demo mode
          </Badge>
        ) : (
          data.modelLabel && (
            <Badge variant="outline" className="text-muted-foreground">
              {data.modelLabel}
            </Badge>
          )
        )}
        <p className="text-muted-foreground w-full text-xs sm:ml-auto sm:w-auto">
          AI suggests — you decide. Nothing changes until a person assigns.
        </p>
      </header>

      <div className="space-y-3 p-4">
        {/* Current closer */}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Users className="text-muted-foreground size-4 shrink-0" />
          <span className="text-muted-foreground text-xs">Current closer</span>
          {data.ownerName ? (
            <span className="font-medium">{data.ownerName}</span>
          ) : (
            <Badge variant="secondary" className="text-[0.625rem]">
              Unassigned
            </Badge>
          )}
          {data.assignment && (
            <span className="text-muted-foreground text-xs">
              assigned {shortDate(data.assignment.assignedAt)}
              {data.assignment.wasOverride
                ? ' · override of AI pick'
                : data.assignment.viaAI
                  ? ' · accepted AI suggestion'
                  : ''}
              {data.assignment.assignedByName ? ` by ${data.assignment.assignedByName}` : ''}
            </span>
          )}
        </div>

        {/* Actions when nothing is pending */}
        {!pending && (
          <div className="flex flex-wrap gap-2">
            {data.canSuggest && (
              <Button variant="outline" size="sm" disabled={busy !== null} onClick={suggest}>
                {busy === 'suggest' ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                Suggest closer (AI)
              </Button>
            )}
            {data.canAssign && data.closers.length > 0 && (
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setManualOpen((v) => !v)}>
                Assign manually
              </Button>
            )}
          </div>
        )}

        {!pending && manualOpen && data.canAssign && (
          <div className="bg-surface-raised/40 space-y-2 rounded-lg border p-3">
            <Label className="text-xs">Assign a closer without an AI suggestion</Label>
            <div className="flex flex-wrap items-center gap-2">
              <CloserPicker data={data} value={pickedId} onChange={setPickedId} />
              <Button size="sm" disabled={!pickedId || busy !== null} onClick={() => apply(pickedId)}>
                {busy === 'apply' ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                Assign
              </Button>
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={resetChoosers}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {error && (
          <p className="border-danger/40 bg-danger/5 text-danger flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs">
            <AlertTriangle className="size-3.5 shrink-0" />
            {error}
          </p>
        )}

        {!pending && !data.canSuggest && !data.canAssign && (
          <p className="bg-surface-sunk/50 text-muted-foreground rounded-md border border-dashed px-3 py-4 text-center text-xs">
            Closer changes are made by someone with reassignment access.
          </p>
        )}

        {/* Pending suggestion */}
        {pending && (
          <article className="bg-surface-raised/40 rounded-lg border p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">AI suggestion</span>
              <Badge variant="secondary" className="text-[0.625rem]">
                Awaiting review
              </Badge>
              {pending.confidence !== null && <ConfidenceMeter value={pending.confidence} />}
              <span className="text-muted-foreground ml-auto text-[0.6875rem]">
                {pending.provider === 'mock' ? 'sample model' : (pending.model ?? pending.provider)} ·{' '}
                {relativeTime(pending.createdAt)}
              </span>
            </div>

            {pending.recommendedCloserName ? (
              <p className="text-sm">
                Suggested closer: <span className="font-semibold">{pending.recommendedCloserName}</span>
              </p>
            ) : (
              <p className="text-warning text-sm">No eligible closer was found for this client.</p>
            )}
            {pending.summary && <p className="text-muted-foreground mt-1 text-xs">{pending.summary}</p>}

            {pending.reasons.length > 0 && (
              <ul className="mt-2 space-y-1">
                {pending.reasons.map((r) => (
                  <li key={`${r.factor}:${r.detail}`} className="flex items-start gap-2 text-xs">
                    <Check className="text-success mt-0.5 size-3 shrink-0" />
                    <span>
                      <span className="font-medium">{r.factor}</span>
                      <span className="text-muted-foreground"> — {r.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-3">
              <RankingList suggestion={pending} />
            </div>

            {pending.missingInformation.length > 0 && (
              <ul className="mt-2 space-y-1">
                {pending.missingInformation.map((m) => (
                  <li key={m.key} className="text-muted-foreground flex items-start gap-1.5 text-xs">
                    <AlertTriangle className="text-warning mt-0.5 size-3 shrink-0" />
                    {m.label}
                  </li>
                ))}
              </ul>
            )}

            <footer className="mt-3 space-y-2 border-t pt-2.5">
              {data.canAssign ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    {recommendedInList && !overrideOpen && (
                      <Button
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => apply(pending.recommendedCloserId!, pending.id)}
                      >
                        {busy === 'apply' ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Check className="size-3.5" />
                        )}
                        Assign {pending.recommendedCloserName}
                      </Button>
                    )}
                    {data.closers.length > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => {
                          setOverrideOpen((v) => !v)
                          setPickedId('')
                          setOverrideReason('')
                        }}
                      >
                        Choose someone else
                      </Button>
                    )}
                    {data.canReview && (
                      <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => dismiss(pending.id)}>
                        {busy === 'dismiss' ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
                        Dismiss
                      </Button>
                    )}
                  </div>

                  {overrideOpen && (
                    <div className="space-y-2 rounded-md border border-dashed p-2.5">
                      <Label className="text-xs">Pick a different closer — an override reason is recorded</Label>
                      <CloserPicker data={data} value={pickedId} onChange={setPickedId} />
                      {pickedId && pickedId !== pending.recommendedCloserId && (
                        <Textarea
                          rows={2}
                          value={overrideReason}
                          onChange={(e) => setOverrideReason(e.target.value)}
                          placeholder="Why this closer instead of the AI pick? (required)"
                        />
                      )}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          disabled={
                            busy !== null ||
                            !pickedId ||
                            (pickedId !== pending.recommendedCloserId && !overrideReason.trim())
                          }
                          onClick={() => apply(pickedId, pending.id, overrideReason)}
                        >
                          {busy === 'apply' ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Check className="size-3.5" />
                          )}
                          {pickedId && pickedId !== pending.recommendedCloserId ? 'Assign with override' : 'Assign'}
                        </Button>
                        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={resetChoosers}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              ) : data.canReview ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-muted-foreground text-xs">Someone with reassignment access makes the assignment.</p>
                  <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => dismiss(pending.id)}>
                    {busy === 'dismiss' ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
                    Dismiss
                  </Button>
                </div>
              ) : (
                <p className="text-muted-foreground text-xs">
                  An authorized reviewer accepts, overrides, or dismisses this suggestion.
                </p>
              )}
            </footer>
          </article>
        )}

        {/* Last decision */}
        {!pending && data.lastDecision && (
          <p className="text-muted-foreground border-t pt-2 text-xs">
            {data.lastDecision.status === 'ACCEPTED' && (
              <>
                Last AI suggestion ({data.lastDecision.recommendedCloserName ?? '—'}) was accepted
                {data.lastDecision.reviewedByName ? ` by ${data.lastDecision.reviewedByName}` : ''}.
              </>
            )}
            {data.lastDecision.status === 'OVERRIDDEN' && (
              <>
                Last AI suggestion ({data.lastDecision.recommendedCloserName ?? '—'}) was overridden
                {data.lastDecision.reviewedByName ? ` by ${data.lastDecision.reviewedByName}` : ''}.
              </>
            )}
            {data.lastDecision.status === 'DISMISSED' && (
              <>
                Last AI suggestion was dismissed
                {data.lastDecision.reviewedByName ? ` by ${data.lastDecision.reviewedByName}` : ''} — no assignment was
                made.
              </>
            )}
          </p>
        )}
      </div>
    </section>
  )
}
