'use client'

import { useState } from 'react'
import { callbackChips, daySlots, safeZone, slotDays, zonedLabel } from '@/lib/call-center/cadence'

function viewerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles'
  } catch {
    return 'America/Los_Angeles'
  }
}

function dayName(day: { year: number; month: number; day: number }, index: number): string {
  if (index === 0) return 'Today'
  if (index === 1) return 'Tomorrow'
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(
    new Date(Date.UTC(day.year, day.month - 1, day.day, 12)),
  )
}

/**
 * The Callback result's time picker. Everything is shown in the LEAD's zone
 * (that is the time they agreed to), with the rep's own time beside it when the
 * two differ. The server checks the time again (ahead, within 60 days).
 */
export function CallbackScheduler({
  name,
  zone,
  now,
  busy = false,
  onSave,
  onCancel,
}: {
  name: string
  zone: string
  now: number
  busy?: boolean
  onSave: (at: string) => void
  onCancel: () => void
}) {
  const leadZone = safeZone(zone)
  const [mine] = useState(viewerZone)
  const [picked, setPicked] = useState<string | null>(null)
  const [dayIndex, setDayIndex] = useState(0)
  const at = new Date(now)
  const chips = callbackChips(at, leadZone)
  const days = slotDays(at, leadZone)
  const day = days[dayIndex] ?? days[0]
  const slots = daySlots(day, leadZone, at)
  const differs = mine !== leadZone && zonedLabel(at.toISOString(), mine, false) !== zonedLabel(at.toISOString(), leadZone, false)

  return (
    <div className="sched" role="group" aria-label={`Call back ${name}`}>
      <p className="muted">
        When should we call {name} back? Times are their time ({leadZone.replace(/_/g, ' ')}).
      </p>
      <div className="sched-chips">
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className={picked === chip.at ? 'on' : ''}
            aria-pressed={picked === chip.at}
            onClick={() => setPicked(chip.at)}
          >
            {chip.label}
            <small>{zonedLabel(chip.at, leadZone)}</small>
          </button>
        ))}
      </div>
      <label className="sched-day">
        Day
        <select value={dayIndex} onChange={(event) => setDayIndex(Number(event.target.value))} aria-label="Day for the call back">
          {days.map((d, index) => (
            <option key={d.key} value={index}>{dayName(d, index)}</option>
          ))}
        </select>
      </label>
      <div className="sched-slots" role="listbox" aria-label="Time for the call back">
        {slots.length ? (
          slots.map((slot) => (
            <button
              key={slot}
              type="button"
              role="option"
              aria-selected={picked === slot}
              className={picked === slot ? 'on' : ''}
              onClick={() => setPicked(slot)}
            >
              {zonedLabel(slot, leadZone, false)}
            </button>
          ))
        ) : (
          <p className="muted">No times left that day. Pick another day.</p>
        )}
      </div>
      {picked ? (
        <p className="sched-pick" role="status">
          Call back {zonedLabel(picked, leadZone)} their time
          {differs ? ` · ${zonedLabel(picked, mine)} your time` : ''}
        </p>
      ) : null}
      <div className="actions">
        <button type="button" className="btn" disabled={!picked || busy} onClick={() => picked && onSave(picked)}>
          Save callback
        </button>
        <button type="button" className="btn secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
