'use client'

import { useState } from 'react'
import { Loader2, Phone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { checkDial } from '@/lib/telephony/actions'
import type { DialCheck, DialTarget } from '@/lib/telephony/voice-contract'
import { actionFailure, thrownMessage } from '@/lib/telephony/ui/result'
import { ContactTimezone } from '@/components/telephony/contact-timezone'
import { useVoice } from './voice-provider'

type Blocked = Extract<DialCheck, { ok: false }>

/**
 * "Call", with the server's do-not-call, consent and calling-hours check in
 * front of it in every phase (plan §2.7).
 *
 * - Browser calling ready: check, then connect through the voice provider.
 *   The `client/voice` webhook checks again and is the authority.
 * - Not ready (P0a, or the flag off): check, then open the `tel:` link.
 *
 * It never dials around a block. The only way past one is the server's own
 * hours override, which only managers are offered and which needs a reason;
 * an unknown time zone is fixed by recording where the person is, never
 * overridden.
 */
export function CallButton({
  target,
  tel,
  who,
  label = 'Call',
  appearance = 'app',
  canOverrideHours = false,
  disabled = false,
  className,
  onDialed,
}: {
  target: DialTarget
  /** Dialable number for the `tel:` flow. Omit when the viewer may not see it. */
  tel?: string | null
  /** Name for the call bar. The server's `who` wins when it has one. */
  who?: string
  label?: string
  appearance?: 'desk' | 'app'
  /** The viewer holds telephony:manage. The server re-checks. */
  canOverrideHours?: boolean
  disabled?: boolean
  /** Extra classes on the wrapper (e.g. full width on a phone). */
  className?: string
  onDialed?: (via: 'browser' | 'tel') => void
}) {
  const voice = useVoice()
  const [pending, setPending] = useState(false)
  const [blocked, setBlocked] = useState<Blocked | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [overriding, setOverriding] = useState(false)
  const [reason, setReason] = useState('')

  const go = async (check: Extract<DialCheck, { ok: true }>) => {
    const name = check.who || who || 'them'
    const local = check.calleeLocalTime ? ` · ${check.calleeLocalTime} their time` : ''
    if (voice) {
      const placed = await voice.call(target, check.line?.id ?? voice.lineId, check.overrideToken, name)
      if (placed) {
        setNotice(`Calling ${name}${local}`)
        onDialed?.('browser')
      }
      return
    }
    const number = tel || check.dial
    if (!number) {
      setNotice("The number isn't shown here. Call them from their record.")
      return
    }
    setNotice(`Calling ${name}${local} (from your phone)`)
    onDialed?.('tel')
    window.location.assign(`tel:${number}`)
  }

  const run = async (override?: { kind: 'hours'; reason: string }) => {
    setPending(true)
    setNotice(null)
    try {
      const res = await checkDial(target, voice?.lineId ?? undefined, override)
      const failure = actionFailure(res)
      if (failure) {
        setBlocked({ ok: false, code: 'CHECK_FAILED', reason: failure.error, canOverride: null })
        return
      }
      const check = res as DialCheck
      if (!check.ok) {
        setBlocked(check)
        return
      }
      setBlocked(null)
      setOverriding(false)
      setReason('')
      await go(check)
    } catch (err) {
      setBlocked({ ok: false, code: 'CHECK_FAILED', reason: thrownMessage(err), canOverride: null })
    } finally {
      setPending(false)
    }
  }

  const busy = pending || (voice ? voice.status !== 'idle' : false)
  const icon = pending ? <Loader2 className="size-3.5 animate-spin" /> : <Phone className="size-3.5" />

  return (
    <div className={['inline-flex flex-col gap-1.5', className].filter(Boolean).join(' ')}>
      {appearance === 'desk' ? (
        <button type="button" className="btn" disabled={disabled || busy} onClick={() => void run()}>
          {label}
        </button>
      ) : (
        <Button variant="outline" size="sm" className="h-11 text-sm sm:h-7 sm:text-[0.8rem]" disabled={disabled || busy} onClick={() => void run()}>
          {icon}
          {label}
        </Button>
      )}

      {notice && (
        <p className="text-muted-foreground max-w-72 text-xs" role="status">
          {notice}
        </p>
      )}

      {blocked && (
        <div className="max-w-72 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs" role="alert">
          <p className="text-amber-900 dark:text-amber-200">{blocked.reason}</p>

          {blocked.code === 'UNKNOWN_TIMEZONE' && (
            <ContactTimezone target={target} onSaved={() => setBlocked(null)} />
          )}

          {blocked.canOverride === 'hours' && canOverrideHours && !overriding && (
            <button
              type="button"
              className="text-primary mt-1.5 underline underline-offset-2"
              onClick={() => setOverriding(true)}
            >
              Call anyway…
            </button>
          )}

          {blocked.canOverride === 'hours' && canOverrideHours && overriding && (
            <div className="mt-2 flex flex-col gap-1.5">
              <label className="flex flex-col gap-1">
                <span className="text-muted-foreground">Why now? This is logged.</span>
                <input
                  className="border-input bg-background h-8 rounded-md border px-2 text-sm"
                  value={reason}
                  maxLength={200}
                  placeholder="They asked us to call back at this time"
                  onChange={(e) => setReason(e.target.value)}
                  aria-label="Reason for calling outside the window"
                />
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="bg-primary text-primary-foreground inline-flex h-7 items-center rounded-md px-2.5 font-medium disabled:opacity-50"
                  disabled={pending || reason.trim().length < 3}
                  onClick={() => void run({ kind: 'hours', reason: reason.trim() })}
                >
                  Call anyway
                </button>
                <button type="button" className="h-7 rounded-md border px-2.5" onClick={() => setOverriding(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
