'use client'

import { durationLabel, timeLabel } from '@/lib/call-center/history-format'
import type { TeamMember } from '@/lib/call-center/team'

/** "1 h 05" over an hour, else "m:ss". */
function talkLabel(seconds: number): string {
  if (seconds < 3600) return durationLabel(seconds)
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h} h ${String(m).padStart(2, '0')}`
}

/**
 * Team (More › Team, `?s=team`): every active user of the workspace, who is
 * on the phone now, and what each did today. No phone numbers.
 */
export function TeamView({ members }: { members: TeamMember[] }) {
  const ready = members.filter((m) => m.ready).length
  const calls = members.reduce((sum, m) => sum + m.calls, 0)
  return (
    <section className="team" aria-label="Team">
      <p className="team-sum muted">
        {ready} on the phone now · {calls} {calls === 1 ? 'call' : 'calls'} today · ready in the last 2 minutes shows green
      </p>
      {members.length ? (
        <ul className="team-list">
          {members.map((m) => (
            <li key={m.id} className="card team-card">
              <div className="team-who">
                <span className={`presence${m.ready ? ' ready' : ''}`} aria-hidden="true" />
                <span>
                  <b>{m.name}</b>
                  <small>{m.role} · {m.ready ? 'Ready' : 'Not on the phone'}</small>
                </span>
              </div>
              <dl className="team-stats">
                <div><dt>Calls</dt><dd>{m.calls}</dd></div>
                <div><dt>Talk</dt><dd>{talkLabel(m.talkSeconds)}</dd></div>
                <div><dt>Booked</dt><dd>{m.booked}</dd></div>
                <div><dt>Last</dt><dd>{m.lastAt ? timeLabel(new Date(m.lastAt)) : '—'}</dd></div>
              </dl>
            </li>
          ))}
        </ul>
      ) : (
        <p className="card block muted">Nobody on the team yet.</p>
      )}
    </section>
  )
}
