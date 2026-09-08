'use client'

import { useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Phone, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { FUNNEL_STEPS, adherencePct, type FunnelStepKey } from '@/lib/adherence'
import { cn } from '@/lib/utils'
import { callLogContextAction, logCallAction } from './log-call-actions'

const OUTCOMES: { value: string; label: string }[] = [
  { value: 'CONNECTED', label: 'Connected — spoke with the client' },
  { value: 'VOICEMAIL', label: 'Voicemail' },
  { value: 'NO_ANSWER', label: 'No answer' },
  { value: 'BUSY', label: 'Busy' },
  { value: 'WRONG_NUMBER', label: 'Wrong number' },
  { value: 'DECLINED', label: 'Declined to talk' },
  { value: 'FAILED', label: 'Call failed' },
]

const emptySteps = (): Record<FunnelStepKey, boolean> => ({
  brief_reviewed: false,
  discovery: false,
  present: false,
  objections: false,
  commitment: false,
})

/**
 * "Log call" — the Phase 1 discipline in one button: every call gets logged,
 * and connected calls get scored against the 5-step funnel on the spot.
 *
 * Self-contained: drop `<LogCallButton clientId={...} />` anywhere on the
 * client page. It fetches whether the latest AI Closer Brief has been viewed
 * (to honestly pre-check step 1) and the server action re-validates
 * everything — permission, scope, and payload — before writing.
 */
export function LogCallButton({ clientId }: { clientId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [direction, setDirection] = useState<'OUTBOUND' | 'INBOUND'>('OUTBOUND')
  const [outcome, setOutcome] = useState('CONNECTED')
  const [duration, setDuration] = useState('')
  const [summary, setSummary] = useState('')
  const [steps, setSteps] = useState<Record<FunnelStepKey, boolean>>(emptySteps)
  const [voicemailLeft, setVoicemailLeft] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  // Pre-check "Reviewed the AI Closer Brief" only when the latest brief was
  // actually viewed — and never fight the user once they touch the checklist.
  const touchedBrief = useRef(false)

  const connected = outcome === 'CONNECTED'
  const entries = useMemo(
    () => FUNNEL_STEPS.map((s) => ({ step: s.key, done: steps[s.key] })),
    [steps],
  )
  const pct = connected ? adherencePct(entries) : null
  const doneCount = FUNNEL_STEPS.filter((s) => steps[s.key]).length

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    setError(null)
    if (!next) return
    touchedBrief.current = false
    callLogContextAction({ clientId }).then((res) => {
      if (res.ok && res.briefViewed && !touchedBrief.current) {
        setSteps((prev) => ({ ...prev, brief_reviewed: true }))
      }
    })
  }

  const setOutcomeValue = (value: string) => {
    setOutcome(value)
    // Sensible default, still user-togglable below.
    if (value === 'VOICEMAIL') setVoicemailLeft(true)
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      const result = await logCallAction({
        clientId,
        direction,
        outcome,
        durationMinutes: duration === '' ? 0 : Number(duration),
        summary,
        // The funnel is a conversation — only connected calls carry a checklist.
        adherence: connected ? entries : [],
        voicemailLeft,
      })
      if (result.ok) {
        toast.success(
          result.adherencePct === null
            ? 'Call logged'
            : `Call logged — ${result.adherencePct}% funnel adherence`,
        )
        setOpen(false)
        setDirection('OUTBOUND')
        setOutcome('CONNECTED')
        setDuration('')
        setSummary('')
        setSteps(emptySteps())
        setVoicemailLeft(false)
        router.refresh()
      } else {
        setError(result.error ?? 'Could not log the call.')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button size="sm" variant="outline">
            <Phone data-slot="icon" /> Log call
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Log a call</DialogTitle>
          <DialogDescription>
            Every call gets logged — it lands on the timeline and keeps this lead out of the
            leak report.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="bg-surface-sunk grid grid-cols-2 gap-1 rounded-lg p-1 text-sm">
            {(
              [
                ['OUTBOUND', 'I called them'],
                ['INBOUND', 'They called me'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setDirection(value)}
                className={cn(
                  'rounded-md py-1.5 font-medium transition-colors',
                  direction === value
                    ? 'bg-surface-raised shadow-e1'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
            <div className="space-y-1.5">
              <Label htmlFor="call-outcome">Outcome</Label>
              <NativeSelect
                id="call-outcome"
                value={outcome}
                onChange={(e) => setOutcomeValue(e.target.value)}
                className="w-full"
              >
                {OUTCOMES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="call-duration">Minutes</Label>
              <Input
                id="call-duration"
                type="number"
                min={0}
                max={600}
                step={1}
                inputMode="numeric"
                placeholder="0"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                className="tabular-nums"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="call-summary">What happened</Label>
            <Textarea
              id="call-summary"
              rows={3}
              required
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder={
                connected
                  ? 'Where the conversation landed, and the agreed next step…'
                  : 'What you tried and what you will do next…'
              }
            />
          </div>

          {connected ? (
            <div className="rounded-lg border">
              <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                <span className="text-sm font-medium">5-step funnel</span>
                <span
                  className={cn(
                    'text-xs font-semibold tabular-nums',
                    pct === 100 ? 'text-success' : pct !== null && pct >= 60 ? 'text-warning' : 'text-muted-foreground',
                  )}
                >
                  {doneCount}/{FUNNEL_STEPS.length} · {pct ?? 0}%
                  {pct === 100 && ' — full adherence'}
                </span>
              </div>
              <ul className="divide-y">
                {FUNNEL_STEPS.map((step, i) => (
                  <li key={step.key}>
                    <label className="hover:bg-muted/40 flex cursor-pointer items-start gap-2.5 px-3 py-2 transition-colors">
                      <Checkbox
                        checked={steps[step.key]}
                        onCheckedChange={(checked) => {
                          if (step.key === 'brief_reviewed') touchedBrief.current = true
                          setSteps((prev) => ({ ...prev, [step.key]: checked === true }))
                        }}
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm leading-tight font-medium">
                          <span className="text-muted-foreground tabular-nums">{i + 1}.</span>{' '}
                          {step.label}
                        </span>
                        <span className="text-muted-foreground block text-xs">{step.hint}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground border-t px-3 py-1.5 text-[0.6875rem]">
                <Sparkles className="text-primary mr-1 inline size-3" />
                100% adherence earns a scoreboard point. Score it honestly — this is coaching
                data, not a grade.
              </p>
            </div>
          ) : (
            <label className="bg-surface-sunk/60 flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5">
              <Checkbox
                checked={voicemailLeft}
                onCheckedChange={(checked) => setVoicemailLeft(checked === true)}
              />
              <span className="text-sm">
                Left a voicemail
                <span className="text-muted-foreground block text-xs">
                  The funnel checklist applies to connected conversations only.
                </span>
              </span>
            </label>
          )}

          {error && <p className="text-danger text-sm">{error}</p>}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? 'Logging…' : 'Log call'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
