'use client'

import { OUTCOMES, type CallLead, type LeadOutcome } from '@/lib/call-center/model'
import { CONNECTED_SECONDS } from '@/lib/call-center/cadence'
import { clockLabel } from '@/lib/telephony/ui/result'
import type { EndedCall } from '@/components/voice/voice-provider'
import type { PowerMode } from './use-power-mode'

/**
 * After a call to a lead ends: what happened, and the result buttons. With
 * power mode on, a result is required before the next dial; with it off the
 * rep may leave it for later.
 */
export function WrapUp({
  lead,
  call,
  required,
  busy,
  error,
  scheduler,
  onOutcome,
  onLater,
}: {
  lead: CallLead
  call: EndedCall
  required: boolean
  busy: boolean
  error: string | null
  /** The callback picker, when the rep chose Callback. */
  scheduler: React.ReactNode
  onOutcome: (outcome: LeadOutcome) => void
  onLater: () => void
}) {
  const short = !call.answered || call.talkSeconds < CONNECTED_SECONDS
  const what = call.error
    ? call.error
    : call.answered
      ? `Talked ${clockLabel(call.talkSeconds)}${short ? ` · under ${CONNECTED_SECONDS} s counts as no answer` : ''}`
      : "They didn't pick up."
  return (
    <section className="card block wrap" aria-label={`Result for the call with ${lead.name}`}>
      <h3>Call ended · {lead.name}</h3>
      <p className="muted">{what}</p>
      <p className="wrap-ask">
        {required ? 'Pick a result to keep going. Power mode waits for it.' : 'How did it go?'}
      </p>
      {error ? <p className="muted" role="status">{error}</p> : null}
      {scheduler ?? (
        <div className="actions">
          {OUTCOMES.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className={`btn secondary${short && item.id === 'no_answer' ? ' suggest' : ''}`}
              disabled={busy}
              onClick={() => onOutcome(item.id)}
            >
              <kbd>{index + 1}</kbd> {item.label}
            </button>
          ))}
          {!required ? (
            <button type="button" className="linkish" onClick={onLater}>Later</button>
          ) : null}
        </div>
      )}
    </section>
  )
}

/** Power mode's status line. Pause and Skip are always on screen while it runs. */
export function PowerBar({ power, nameOf }: { power: PowerMode; nameOf: (id: string | null) => string | null }) {
  if (!power.on) return null
  const nextName = power.next?.lead.name ?? null
  let line: string
  switch (power.phase) {
    case 'countdown':
      line = nextName
        ? power.paused
          ? `Paused. Next up: ${nextName}.`
          : `Calling ${nextName} in ${power.remaining} s`
        : 'Nobody left to call right now.'
      break
    case 'dialing':
      line = 'On the call. Pick a result when it ends.'
      break
    case 'stopped': {
      const who = nameOf(power.stoppedLeadId)
      line = `Stopped${who ? ` on ${who}` : ''}: ${power.stopReason ?? 'Power mode stopped.'}`
      break
    }
    default:
      line = 'Power mode is on. Start dials the top lead on Today.'
  }
  const canStart = power.phase === 'idle' || power.phase === 'stopped'
  return (
    <div className={`power-bar${power.phase === 'stopped' ? ' stopped' : ''}`} role="status" aria-live="polite">
      <span className="power-line">{line}</span>
      <div className="power-acts">
        {canStart ? (
          <button type="button" className="btn" onClick={power.start}>Start</button>
        ) : null}
        <button
          type="button"
          className="btn secondary"
          disabled={power.phase !== 'countdown'}
          aria-pressed={power.paused}
          onClick={power.pause}
        >
          {power.paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          className="btn secondary"
          disabled={!(power.phase === 'countdown' && power.next) && !(power.phase === 'stopped' && power.stoppedLeadId)}
          onClick={power.skip}
        >
          Skip lead
        </button>
      </div>
    </div>
  )
}
