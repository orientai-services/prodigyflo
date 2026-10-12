'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { Ban, CalendarCheck, CalendarClock, CalendarPlus, ClipboardList, Hand, Link2, StickyNote, UserPlus, type LucideIcon } from 'lucide-react'
import { loadMoreActivity } from '@/lib/call-center/history-actions'
import type { ActivityKind, ActivityRow } from '@/lib/call-center/history-format'
import './history.css'

const ICON: Record<ActivityKind, LucideIcon> = {
  outcome: ClipboardList,
  note: StickyNote,
  lock: Hand,
  intake: Link2,
  form: UserPlus,
  hold: CalendarPlus,
  confirm: CalendarCheck,
  visit: CalendarClock,
  dnc: Ban,
  audit: ClipboardList,
}

/** The desk's activity, newest first, with who and when. "Load more" appends. */
export function ActivityList({ initial, nextCursor }: { initial: ActivityRow[]; nextCursor: string | null }) {
  const [rows, setRows] = useState(initial)
  const [cursor, setCursor] = useState(nextCursor)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  function more() {
    if (!cursor) return
    setError(null)
    start(async () => {
      try {
        const page = await loadMoreActivity(cursor)
        setRows((prev) => {
          const seen = new Set(prev.map((r) => r.key))
          return [...prev, ...page.rows.filter((r) => !seen.has(r.key))]
        })
        setCursor(page.nextCursor)
      } catch {
        setError("Couldn't load more. Try again.")
      }
    })
  }

  if (!rows.length) return <p className="hist-empty">Nothing has happened on the desk yet.</p>

  return (
    <>
      <ul className="hist-list hist-activity">
        {rows.map((row) => {
          const Icon = ICON[row.kind]
          return (
            <li key={row.key} className={`hist-row a-${row.kind}`}>
              <div className="hist-line">
                <span className="hist-ico" aria-hidden="true">
                  <Icon size={18} strokeWidth={2} />
                </span>
                <div className="hist-main">
                  <b className="hist-name">
                    {row.title}
                    {row.subject ? (
                      <>
                        {' · '}
                        {row.href ? <Link href={row.href}>{row.subject}</Link> : <span>{row.subject}</span>}
                      </>
                    ) : null}
                  </b>
                  {row.detail ? <span className="hist-detail">{row.detail}</span> : null}
                  <span className="hist-meta">
                    {[row.who, `${row.day}, ${row.time}`].filter(Boolean).join(' · ')}
                  </span>
                </div>
              </div>
            </li>
          )
        })}
      </ul>
      {error ? <p className="hist-error" role="alert">{error}</p> : null}
      {cursor ? (
        <button type="button" className="btn secondary hist-more" onClick={more} disabled={pending}>
          {pending ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
    </>
  )
}
