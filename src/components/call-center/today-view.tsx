'use client'

import type { QueueItem, TodayBoard } from '@/lib/call-center/priority'
import { languageLabel, lockLabel, phoneLabel, type CallLead } from '@/lib/call-center/model'

const QUEUES: { id: keyof TodayBoard['queues']; label: string; empty: string }[] = [
  { id: 'callbacks', label: 'Callbacks requested / missed', empty: 'No callbacks or missed calls.' },
  { id: 'due', label: 'Due now', empty: 'Nothing due right now.' },
  { id: 'fresh', label: 'New', empty: 'No new leads waiting.' },
  { id: 'cold', label: 'Going cold', empty: 'Nobody is going cold.' },
]

function Row({
  item,
  rep,
  selectedId,
  onOpen,
}: {
  item: QueueItem
  rep: (lead: CallLead) => string
  selectedId: string | null
  onOpen: (lead: CallLead) => void
}) {
  const { lead } = item
  const lock = lockLabel(lead, rep(lead))
  return (
    <li>
      <button
        type="button"
        className={['today-row', selectedId === lead.id ? 'on' : '', item.hot ? 'hot' : ''].filter(Boolean).join(' ')}
        aria-current={selectedId === lead.id ? 'true' : undefined}
        onClick={() => onOpen(lead)}
      >
        <b>{lead.name}</b>
        <span className="why">{item.why}</span>
        <span className="meta">
          {languageLabel(lead.language)} · {phoneLabel(lead)}
          {lock ? ` · ${lock}` : ''}
        </span>
      </button>
    </li>
  )
}

/**
 * The desk's default tab: four numbers, the three leads to call first (each
 * with a one-line why), then the queues. Ranking is `priority.ts`; this only
 * draws it.
 */
export function TodayView({
  board,
  rep,
  selectedId,
  onOpen,
}: {
  board: TodayBoard
  rep: (lead: CallLead) => string
  selectedId: string | null
  onOpen: (lead: CallLead) => void
}) {
  const { kpis } = board
  return (
    <div className="today">
      <dl className="kpis">
        <div><dt>New not contacted</dt><dd>{kpis.newNotContacted}</dd></div>
        <div><dt>Follow-ups due</dt><dd>{kpis.followUpsDue}</dd></div>
        <div><dt>Booked today</dt><dd>{kpis.bookedToday}</dd></div>
        <div><dt>Calls today</dt><dd>{kpis.callsToday}</dd></div>
      </dl>
      <section className="card block first" aria-label="Call first">
        <h3>Call first</h3>
        {board.callFirst.length ? (
          <ol className="today-list">
            {board.callFirst.map((row) => (
              <Row key={row.lead.id} item={row} rep={rep} selectedId={selectedId} onOpen={onOpen} />
            ))}
          </ol>
        ) : (
          <p className="muted">Nobody to call right now. New forms and due follow-ups show up here.</p>
        )}
      </section>
      {QUEUES.map((queue) => {
        const items = board.queues[queue.id]
        return (
          <details key={queue.id} className="card queue" open={queue.id !== 'cold' && items.length > 0}>
            <summary>
              {queue.label}
              <span className="count">{items.length}</span>
            </summary>
            {items.length ? (
              <ul className="today-list">
                {items.map((item) => (
                  <Row key={item.lead.id} item={item} rep={rep} selectedId={selectedId} onOpen={onOpen} />
                ))}
              </ul>
            ) : (
              <p className="muted pad">{queue.empty}</p>
            )}
          </details>
        )
      })}
    </div>
  )
}
