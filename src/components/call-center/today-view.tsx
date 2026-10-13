'use client'

import Link from 'next/link'
import { useState, useSyncExternalStore } from 'react'
import { Play, X } from 'lucide-react'
import {
  agoLabel,
  dateLine,
  invalidNumber,
  lastContactAt,
  latestRecording,
  noteSnippet,
  sectionHref,
  stageOf,
  visitLabel,
  type TodayCounts,
} from '@/lib/call-center/app-shell'
import type { TodayBoard } from '@/lib/call-center/priority'
import type { FeedRow, TodayStats } from '@/lib/call-center/team'
import { lockLabel, type CallLead } from '@/lib/call-center/model'
import { CallButton } from '@/components/voice/call-button'
import { RecordingPlayer } from '@/components/voice/recording-player'

/** How many leads "What to attack first" lists. */
export const ATTACK_COUNT = 10

const EXPLAINER_KEY = 'cc.today.explainer.hidden'
const EXPLAINER_EVENT = 'cc-today-explainer'

function explainerHidden(): boolean {
  try {
    return window.localStorage.getItem(EXPLAINER_KEY) === '1'
  } catch {
    return false
  }
}

function onExplainer(change: () => void): () => void {
  window.addEventListener(EXPLAINER_EVENT, change)
  window.addEventListener('storage', change)
  return () => {
    window.removeEventListener(EXPLAINER_EVENT, change)
    window.removeEventListener('storage', change)
  }
}

function hideExplainer() {
  try {
    window.localStorage.setItem(EXPLAINER_KEY, '1')
  } catch {
    // Private mode: it stays hidden until the page reloads.
  }
  window.dispatchEvent(new Event(EXPLAINER_EVENT))
}

export type TodayServer = {
  stats: TodayStats | null
  /** Today's team feed, newest first; null when it could not be read. */
  feed: FeedRow[] | null
  count: number
}

/**
 * The Today section (docs/DIALER_APP.md §2): the date, four tiles that open
 * their lists, a short explainer, what the team did today, and the ten
 * leads to attack first. Ranking is `priority.ts`; this only draws it.
 */
export function TodayView({
  board,
  counts,
  now,
  server,
  rep,
  selectedId,
  canOverrideHours,
  resultOwed,
  onOpen,
  onTelDialed,
  onPrepareCall,
}: {
  board: TodayBoard
  counts: TodayCounts
  /** The desk clock (ms). */
  now: number
  server: TodayServer | null
  rep: (lead: CallLead) => string
  selectedId: string | null
  canOverrideHours?: boolean
  /** Power mode is waiting on a result: no new dial. */
  resultOwed: boolean
  onOpen: (lead: CallLead) => void
  /** A `tel:` dial records its own attempt (a browser call is written by the carrier webhooks). */
  onTelDialed: (lead: CallLead) => void
  /** Takes the lead for this rep before its Call is checked (the server only dials a lead the rep holds). */
  onPrepareCall?: (lead: CallLead) => Promise<string | null>
}) {
  const hidden = useSyncExternalStore(onExplainer, explainerHidden, () => false)
  const [listening, setListening] = useState<string | null>(null)
  const stats = server?.stats ?? null
  const feed = server?.feed ?? null
  const rows = board.ranked.slice(0, ATTACK_COUNT)
  const tiles = [
    { label: 'Not contacted', value: counts.notContacted, hint: 'call these first', href: sectionHref('leads', 'uncontacted') },
    { label: 'Follow-ups today', value: counts.followUps, hint: 'due today or overdue', href: sectionHref('leads', 'due') },
    { label: 'Booked', value: stats?.bookedWeek ?? null, hint: 'visits this week', href: sectionHref('booked') },
    { label: 'Confirmed today', value: stats?.confirmedToday ?? null, hint: 'confirmed on the call', href: sectionHref('booked') },
  ]

  return (
    <div className="today">
      <p className="today-date">{now ? dateLine(new Date(now)) : null}</p>
      <nav className="tiles" aria-label="Today at a glance">
        {tiles.map((tile) => (
          <Link key={tile.label} href={tile.href} className="tile">
            <span className="tile-label">{tile.label}</span>
            <b className="tile-value">{tile.value ?? '—'}</b>
            <span className="tile-hint">{tile.hint}</span>
          </Link>
        ))}
      </nav>

      {hidden ? null : (
        <aside className="card explainer" aria-label="How Today works">
          <p>
            This is your call list for the day. When someone fills out the ad&rsquo;s form, the faster you call, the
            easier the sale. The ones waiting longest are at the top.
          </p>
          <button type="button" className="explainer-x" aria-label="Hide this note" onClick={hideExplainer}>
            <X aria-hidden="true" />
          </button>
        </aside>
      )}

      <section className="card block attack" aria-label="What to attack first">
        <div className="attack-head">
          <h3>What to attack first</h3>
          <span className="muted updates">updates by itself</span>
        </div>
        {rows.length ? (
          <ol className="attack-list">
            {rows.map((row, index) => {
              const { lead } = row
              const stage = stageOf(lead)
              const lock = lockLabel(lead, rep(lead))
              const touched = lastContactAt(lead)
              const note = noteSnippet(lead)
              const recording = latestRecording(lead)
              const visit = stats?.appointments[lead.id] ?? null
              const invalid = invalidNumber(lead)
              const listenOpen = recording !== null && listening === lead.id
              return (
                <li key={lead.id} className={['attack-row', selectedId === lead.id ? 'on' : '', row.hot ? 'hot' : ''].filter(Boolean).join(' ')}>
                  <span className="attack-n" aria-hidden="true">{index + 1}</span>
                  <div className="attack-body">
                    <button
                      type="button"
                      className="attack-name"
                      aria-current={selectedId === lead.id ? 'true' : undefined}
                      onClick={() => onOpen(lead)}
                    >
                      {lead.name}
                    </button>
                    <span className="attack-why">{row.why}</span>
                    <span className="attack-meta">
                      <span className={`stage ${stage.tone}`}>{stage.label}</span>
                      {lock ? <span>{lock}</span> : null}
                      {visit ? <span>📅 {visitLabel(visit)}</span> : null}
                      {touched !== null ? <span>☎ {agoLabel(now - touched)}</span> : null}
                    </span>
                    {note ? <span className="attack-note">{note}</span> : null}
                    {listenOpen && recording ? (
                      <RecordingPlayer src={recording.src} seconds={recording.seconds} className="attack-player" />
                    ) : null}
                  </div>
                  <div className="attack-acts">
                    {invalid ? (
                      <span className="chip-bad" role="note">Invalid number</span>
                    ) : lead.persisted ? (
                      <CallButton
                        key={lead.id}
                        appearance="desk"
                        target={{ kind: 'lead', id: lead.id }}
                        who={lead.name}
                        canOverrideHours={canOverrideHours}
                        disabled={!row.available || resultOwed}
                        prepare={onPrepareCall ? () => onPrepareCall(lead) : undefined}
                        onDialed={(via) => {
                          if (via === 'tel') onTelDialed(lead)
                        }}
                      />
                    ) : (
                      <button type="button" className="btn" disabled={!row.available} onClick={() => onOpen(lead)}>
                        Call
                      </button>
                    )}
                    {recording ? (
                      <button
                        type="button"
                        className="listen"
                        aria-expanded={listenOpen}
                        onClick={() => setListening(listenOpen ? null : lead.id)}
                      >
                        <Play aria-hidden="true" />
                        Listen · {recording.length} · {agoLabel(now - Date.parse(recording.at))}
                      </button>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ol>
        ) : (
          <p className="muted">Nobody to call right now. New forms and due follow-ups show up here.</p>
        )}
      </section>

      <section className="card block team-today" aria-label="Team activity today">
        <div className="attack-head">
          <h3>Team activity today</h3>
          {feed ? <span className="count">{server?.count ?? feed.length}</span> : null}
        </div>
        {feed === null ? (
          <p className="muted">Team activity isn&rsquo;t available right now.</p>
        ) : feed.length ? (
          <ul className="feed">
            {feed.map((row) => (
              <li key={row.key} className={`feed-row ${row.kind}`}>
                <time dateTime={row.at}>{row.time}</time>
                <span>{row.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Nobody has done anything yet today.</p>
        )}
      </section>
    </div>
  )
}
