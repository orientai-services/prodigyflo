'use client'

import { useEffect, useState, useTransition } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { getTwilioStatus, setManualCarrierState, setVoiceLimitedMode } from '@/lib/telephony/actions'
import type { CarrierState, TwilioStatusVM } from '@/lib/telephony/voice-contract'
import { actionFailure, thrownMessage, whenLabel } from '@/lib/telephony/ui/result'

/**
 * What the carrier account looks like right now, on one card (plan §2.8, §3).
 *
 * The server scopes every field: the platform owner sees the shared account
 * (balance, every number, env, errors); everyone else sees their own lines
 * and their own errors. The card renders what it is given and never infers
 * an account-wide fact from a scoped one. Env rows show names only.
 */

const PROFILE_WORDS: Record<string, string> = {
  'twilio-approved': 'Approved',
  approved: 'Approved',
  'pending-review': 'Pending review',
  'in-review': 'In review',
  draft: 'Not submitted',
  'twilio-rejected': 'Rejected',
  rejected: 'Rejected',
}

const A2P_WORDS: Record<string, string> = {
  verified: 'Approved',
  approved: 'Approved',
  pending: 'Pending',
  in_progress: 'Pending',
  'in-progress': 'Pending',
  failed: 'Rejected',
  rejected: 'Rejected',
}

function carrierWord(state: CarrierState, words: Record<string, string>): string {
  if (state.source === 'unknown' || !state.status) return 'Unknown'
  return words[state.status.toLowerCase()] ?? state.status
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-3 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

export function TwilioStatusCard({ initial = null }: { initial?: TwilioStatusVM | null }) {
  const [vm, setVm] = useState<TwilioStatusVM | null>(initial)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const load = (refresh: boolean) => {
    setError(null)
    startTransition(async () => {
      try {
        const res = await getTwilioStatus(refresh)
        const failure = actionFailure(res)
        if (failure) setError(failure.error)
        else setVm(res as TwilioStatusVM)
      } catch (err) {
        setError(thrownMessage(err))
      }
    })
  }

  // With no server-rendered status, read the stored one once. Refresh asks the carrier again.
  const hasInitial = initial !== null
  useEffect(() => {
    if (hasInitial) return
    let cancelled = false
    getTwilioStatus(false)
      .then((res: unknown) => {
        if (cancelled) return
        const failure = actionFailure(res)
        if (failure) setError(failure.error)
        else setVm(res as TwilioStatusVM)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(thrownMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [hasInitial])

  const change = (run: () => Promise<unknown>) => {
    setError(null)
    startTransition(async () => {
      try {
        const failure = actionFailure(await run())
        if (failure) {
          setError(failure.error)
          return
        }
        const res = await getTwilioStatus(false)
        if (!actionFailure(res)) setVm(res as TwilioStatusVM)
      } catch (err) {
        setError(thrownMessage(err))
      }
    })
  }

  const canChange = vm?.voiceLimited.canChange ?? false

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          Twilio
          {vm && (
            <Badge variant={vm.mode === 'twilio' ? 'secondary' : 'outline'}>
              {vm.mode === 'twilio' ? 'Live' : 'Test mode'}
            </Badge>
          )}
          {vm?.scope === 'platform' && <Badge variant="outline">Whole account</Badge>}
        </CardTitle>
        <CardDescription>
          {vm?.mode === 'mock'
            ? 'Test mode. No real calls are placed.'
            : vm?.scope === 'platform'
              ? 'The shared phone account every workspace on it uses.'
              : 'Your lines and what the carrier said about them.'}
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={() => load(true)} disabled={pending}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            Refresh
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {error && (
          <p className="text-destructive mb-2 text-sm" role="alert">
            {error}
          </p>
        )}
        {!vm ? (
          <p className="text-muted-foreground text-sm">{pending ? 'Checking…' : 'No status yet.'}</p>
        ) : (
          <dl className="divide-y">
            <Row label="Account">
              <span className="font-mono text-xs">{vm.account}</span>
            </Row>
            {vm.balance !== null && <Row label="Balance">{vm.balance}</Row>}
            <Row label="Numbers">
              {vm.numbers.here} here
              {vm.numbers.inTwilio !== null && ` · ${vm.numbers.inTwilio} in Twilio`}
              {vm.numbers.drift > 0 && (
                <span className="text-amber-700 dark:text-amber-400">
                  {' '}
                  · {vm.numbers.drift} point{vm.numbers.drift === 1 ? 's' : ''} elsewhere
                </span>
              )}
            </Row>
            <Row label="Business profile">
              {carrierWord(vm.profile, PROFILE_WORDS)}
              {vm.profile.source === 'manual' && <span className="text-muted-foreground"> (entered by hand)</span>}
              {vm.profile.note && <p className="text-muted-foreground text-xs">{vm.profile.note}</p>}
              {canChange && (
                <ManualSelect
                  label="Set by hand"
                  options={[
                    ['twilio-approved', 'Approved'],
                    ['pending-review', 'Pending review'],
                    ['twilio-rejected', 'Rejected'],
                  ]}
                  disabled={pending}
                  onPick={(value) => change(() => setManualCarrierState({ profile: value }))}
                />
              )}
            </Row>
            <Row label="Texting registration">
              {carrierWord(vm.a2p, A2P_WORDS)}
              {vm.a2p.source === 'manual' && <span className="text-muted-foreground"> (entered by hand)</span>}
              {vm.a2p.note && <p className="text-muted-foreground text-xs">{vm.a2p.note}</p>}
              {carrierWord(vm.a2p, A2P_WORDS) !== 'Approved' && (
                <p className="text-muted-foreground text-xs">Texts may be blocked until it is approved.</p>
              )}
              {canChange && (
                <ManualSelect
                  label="Set by hand"
                  options={[
                    ['approved', 'Approved'],
                    ['pending', 'Pending'],
                    ['failed', 'Rejected'],
                  ]}
                  disabled={pending}
                  onPick={(value) => change(() => setManualCarrierState({ a2p: value }))}
                />
              )}
            </Row>
            <Row label="Calls at once">
              {vm.voiceLimited.on ? 'One call at a time until Twilio approves the business profile.' : 'No limit'}
              {vm.voiceLimited.why && <p className="text-muted-foreground text-xs">{vm.voiceLimited.why}</p>}
              {canChange && (
                <div className="mt-1.5 flex flex-wrap gap-1" role="radiogroup" aria-label="Call limit">
                  {(
                    [
                      ['auto', 'Automatic'],
                      ['on', 'One at a time'],
                      ['off', 'No limit'],
                    ] as const
                  ).map(([mode, text]) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={vm.voiceLimited.mode === mode}
                      disabled={pending}
                      onClick={() => change(() => setVoiceLimitedMode(mode))}
                      className={[
                        'h-7 rounded-md border px-2 text-xs',
                        vm.voiceLimited.mode === mode ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted',
                      ].join(' ')}
                    >
                      {text}
                    </button>
                  ))}
                </div>
              )}
            </Row>
            <Row label="Recording privacy">
              {vm.mediaAuth.state === 'on' ? (
                'On'
              ) : vm.mediaAuth.state === 'off' ? (
                <span className="text-destructive">Off — recordings are public at Twilio</span>
              ) : (
                'Not checked yet'
              )}
              {vm.mediaAuth.checkedAt && (
                <p className="text-muted-foreground text-xs">Checked {whenLabel(vm.mediaAuth.checkedAt)}</p>
              )}
              {vm.mediaAuth.state === 'off' && (
                <p className="text-muted-foreground text-xs">Turn on HTTP auth for media in Twilio&rsquo;s voice settings.</p>
              )}
              {canChange && vm.mediaAuth.state !== 'on' && (
                <button
                  type="button"
                  className="text-primary mt-1 text-xs underline underline-offset-2"
                  disabled={pending}
                  onClick={() => change(() => setManualCarrierState({ mediaAuth: 'on' }))}
                >
                  I turned it on in Twilio
                </button>
              )}
            </Row>
            {vm.env.length > 0 && (
              <Row label="Settings">
                <ul className="grid gap-0.5 text-xs">
                  {vm.env.map((e) => (
                    <li key={e.name} className="flex items-center gap-2">
                      <span className={e.set ? 'text-emerald-600' : 'text-destructive'}>{e.set ? 'Set' : 'Missing'}</span>
                      <span className="font-mono">{e.name}</span>
                    </li>
                  ))}
                </ul>
              </Row>
            )}
            <Row label="Recent errors">
              {vm.recentErrors.length === 0 ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                <ul className="grid gap-1 text-xs">
                  {vm.recentErrors.map((e) => (
                    <li key={e.code}>
                      <span className="font-mono">{e.code}</span> {e.meaning} · {e.count}× · last {whenLabel(e.lastAt)}
                    </li>
                  ))}
                </ul>
              )}
            </Row>
            {vm.checkedAt && (
              <p className="text-muted-foreground pt-2 text-xs">Last checked with Twilio {whenLabel(vm.checkedAt)}</p>
            )}
          </dl>
        )}
      </CardContent>
    </Card>
  )
}

function ManualSelect({
  label,
  options,
  disabled,
  onPick,
}: {
  label: string
  options: [string, string][]
  disabled: boolean
  onPick: (value: string) => void
}) {
  return (
    <select
      className="border-input bg-background mt-1.5 h-7 rounded-md border px-1.5 text-xs"
      value=""
      disabled={disabled}
      aria-label={label}
      onChange={(e) => {
        if (e.target.value) onPick(e.target.value)
      }}
    >
      <option value="">{label}…</option>
      {options.map(([value, text]) => (
        <option key={value} value={value}>
          {text}
        </option>
      ))}
    </select>
  )
}
