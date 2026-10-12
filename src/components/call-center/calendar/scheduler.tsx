'use client'

import { useEffect, useRef, useState } from 'react'
import { holdCalendarSlot, loadCalendarScheduler, rescheduleCalendarSlot, type CalendarResult } from '@/lib/call-center/calendar/actions'
import { MAX_DAYS_AHEAD, VISIT_MINUTES } from '@/lib/call-center/calendar/config'
import { leadIdOfTarget } from '@/lib/call-center/lead-link'
import {
  addDays,
  bestRep,
  dayKeyOf,
  firstOpenDay,
  monthTitle,
  openingsByRep,
  rangeLabel,
  reasonText,
  schedulerChips,
  schedulerMonth,
  shiftDate,
  visitWhen,
  type SchedulerData,
} from '@/lib/call-center/calendar/planner'
import { useVoice } from '@/components/voice/voice-provider'
import './calendar.css'

export type SchedulerLead = { id: string; name: string }

/** A fresh hold, or moving an existing visit (the old one is marked Rescheduled). */
export type SchedulerMode = { kind: 'hold' } | { kind: 'reschedule'; slotId: string; repKey: string; startsAt: string }

const HEADS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

function firstOfMonth(key: string): string {
  return `${key.slice(0, 7)}-01`
}

/** Sheet chrome shared by the scheduler and its loading state. Escape and the backdrop close it. */
function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return (
    <>
      <div className="cal-sched-backdrop" aria-hidden="true" onClick={onClose} />
      <div
        ref={ref}
        className="cal-sched"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          onClose()
        }}
      >
        <div className="cal-grab" aria-hidden="true" />
        {children}
      </div>
    </>
  )
}

/**
 * The booking popover (docs/CALENDAR.md §3): a month mini-grid for the day,
 * 30-minute chips for one rep, and Place hold. Chips carry the same reason
 * `holdSlot` would refuse with; the server checks every rule again.
 */
export function VisitScheduler({
  data,
  lead,
  mode = { kind: 'hold' },
  onClose,
  onSaved,
}: {
  data: SchedulerData
  lead: SchedulerLead
  mode?: SchedulerMode
  onClose: () => void
  onSaved?: () => void
}) {
  const voice = useVoice()
  // Opened by a tap, so the browser's clock is safe here (no server render).
  const [now] = useState(() => new Date())
  const today = dayKeyOf(now)
  const first = firstOpenDay(now)
  const reps = data.reps
  const keys = reps.map((r) => r.key)
  // Moving a visit: its own time no longer counts against its rep.
  const busy = mode.kind === 'reschedule'
    ? data.busy.filter((b) => !(b.repKey === mode.repKey && Date.parse(b.startsAt) === Date.parse(mode.startsAt)))
    : data.busy
  const [day, setDay] = useState(first)
  const [month, setMonth] = useState(firstOfMonth(first))
  const [repPick, setRepPick] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)

  const input = { dayKey: day, now, busy, hours: data.hours }
  const repKey = repPick ?? bestRep({ ...input, reps: keys }) ?? keys[0]
  const rep = reps.find((r) => r.key === repKey) ?? reps[0]
  const counts = openingsByRep({ ...input, reps: keys })
  const chips = schedulerChips({ ...input, repKey })
  const liveCall = Boolean(voice?.activeTarget && leadIdOfTarget(voice.activeTarget) === lead.id)
  const moving = mode.kind === 'reschedule'
  const minMonth = firstOfMonth(today)
  const maxMonth = firstOfMonth(addDays(today, MAX_DAYS_AHEAD))

  function pickDay(key: string) {
    setDay(key)
    setPicked(null)
    setMsg(null)
  }

  async function save(confirm: boolean) {
    if (!picked || !rep) return
    setSaving(true)
    setMsg(null)
    let res: CalendarResult
    try {
      res = moving
        ? await rescheduleCalendarSlot({ slotId: mode.slotId, repKey: rep.key, startsAt: picked })
        : await holdCalendarSlot({ leadId: lead.id, repKey: rep.key, startsAt: picked, confirm })
    } catch {
      res = { ok: false, reason: 'Could not save. Check the connection and try again.' }
    }
    setSaving(false)
    if (!res.ok) {
      setMsg({ ok: false, text: reasonText(res.reason) })
      return
    }
    const end = new Date(Date.parse(picked) + VISIT_MINUTES * 60_000).toISOString()
    const what = moving ? 'Visit moved to' : confirm ? 'Confirmed' : 'Hold placed'
    setMsg({ ok: true, text: `${what}: ${visitWhen(picked, end)} with ${rep.label}.` })
    setDone(true)
    onSaved?.()
  }

  return (
    <Sheet label={`${moving ? 'Move the visit for' : 'Book a visit for'} ${lead.name}`} onClose={onClose}>
      <header className="cal-sched-head">
        <div>
          <h3>{moving ? 'Move the visit' : 'Book a visit'}</h3>
          <p className="muted">{lead.name} · 90 minutes · Times are Pacific.</p>
        </div>
        <button type="button" className="cal-x" aria-label="Close" onClick={onClose}>×</button>
      </header>
      <div className="cal-sched-body">
        <section className="cal-sched-days" aria-label="Day">
          <div className="cal-mini-head">
            <button type="button" aria-label="Previous month" disabled={month <= minMonth} onClick={() => setMonth(shiftDate('month', month, -1))}>‹</button>
            <b>{monthTitle(month)}</b>
            <button type="button" aria-label="Next month" disabled={month >= maxMonth} onClick={() => setMonth(shiftDate('month', month, 1))}>›</button>
          </div>
          <div className="cal-mini">
            {HEADS.map((h, i) => <span key={i} className="cal-mini-wd" aria-hidden="true">{h}</span>)}
            {schedulerMonth(month, now).flat().map((cell) => (
              <button
                key={cell.key}
                type="button"
                className={['cal-mini-day', cell.inMonth ? '' : 'out', cell.today ? 'today' : '', cell.key === day ? 'on' : ''].filter(Boolean).join(' ')}
                disabled={!cell.enabled}
                aria-pressed={cell.key === day}
                aria-label={rangeLabel('day', cell.key)}
                onClick={() => pickDay(cell.key)}
              >
                {cell.day}
              </button>
            ))}
          </div>
          <p className="muted cal-hint">Visits start at least 2 hours from now and up to 5 days ahead.</p>
        </section>
        <section className="cal-sched-times" aria-label="Time">
          <div className="cal-reps" role="radiogroup" aria-label="Rep">
            {reps.map((r) => (
              <button
                key={r.key}
                type="button"
                role="radio"
                aria-checked={r.key === repKey}
                className={`cal-rep-btn cal-rep-${r.color}${r.key === repKey ? ' on' : ''}`}
                onClick={() => {
                  setRepPick(r.key)
                  setPicked(null)
                  setMsg(null)
                }}
              >
                <i className="cal-dot" aria-hidden="true" />
                {r.label}
                <small>{counts.get(r.key) ?? 0} open</small>
              </button>
            ))}
          </div>
          <p className="cal-day-label">{rangeLabel('day', day)}</p>
          <div className="cal-times" role="listbox" aria-label={`Start times with ${rep?.label ?? 'the rep'}`}>
            {chips.map((chip) => {
              const why = chip.problem ? reasonText(chip.problem) : null
              return (
                <button
                  key={chip.startsAt}
                  type="button"
                  role="option"
                  aria-selected={picked === chip.startsAt}
                  aria-disabled={Boolean(why)}
                  title={why ?? undefined}
                  className={[picked === chip.startsAt ? 'on' : '', why ? 'off' : ''].filter(Boolean).join(' ')}
                  onClick={() => {
                    if (done) return
                    if (why) {
                      setMsg({ ok: false, text: `${chip.label}: ${why}` })
                      return
                    }
                    setPicked(chip.startsAt)
                    setMsg(null)
                  }}
                >
                  {chip.label}
                </button>
              )
            })}
          </div>
          {chips.every((chip) => chip.problem) ? <p className="muted">No open times for {rep?.label} that day. Try another rep or day.</p> : null}
        </section>
      </div>
      {picked && !done ? (
        <p className="cal-pick">
          {visitWhen(picked, new Date(Date.parse(picked) + VISIT_MINUTES * 60_000).toISOString())} with {rep?.label}
        </p>
      ) : null}
      {msg ? <p className={`cal-msg ${msg.ok ? 'ok' : 'bad'}`} role="status">{msg.text}</p> : null}
      <div className="cal-sched-acts">
        {done ? (
          <button type="button" className="btn" onClick={onClose}>Done</button>
        ) : (
          <>
            <button type="button" className="btn" disabled={!picked || saving} onClick={() => { void save(false) }}>
              {saving ? 'Saving…' : moving ? 'Move visit' : 'Place hold'}
            </button>
            {liveCall && !moving ? (
              <button type="button" className="btn secondary" disabled={!picked || saving} onClick={() => { void save(true) }}>
                Hold and confirm
              </button>
            ) : null}
            <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          </>
        )}
      </div>
    </Sheet>
  )
}

/**
 * The lead panel's Book visit: reads the reps' openings when it opens, then
 * shows the same scheduler the Calendar tab uses.
 */
export function BookVisit({ lead, onClose, onSaved }: { lead: SchedulerLead; onClose: () => void; onSaved?: () => void }) {
  const [data, setData] = useState<SchedulerData | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancel = false
    loadCalendarScheduler()
      .then((next) => {
        if (cancel) return
        if (next) setData(next)
        else setFailed(true)
      })
      .catch(() => {
        if (!cancel) setFailed(true)
      })
    return () => {
      cancel = true
    }
  }, [])
  if (data) return <VisitScheduler data={data} lead={lead} onClose={onClose} onSaved={onSaved} />
  return (
    <Sheet label={`Book a visit for ${lead.name}`} onClose={onClose}>
      <header className="cal-sched-head">
        <div>
          <h3>Book a visit</h3>
          <p className="muted">{failed ? 'The calendar could not be read. Close and try again.' : 'Reading the reps’ openings…'}</p>
        </div>
        <button type="button" className="cal-x" aria-label="Close" onClick={onClose}>×</button>
      </header>
    </Sheet>
  )
}
