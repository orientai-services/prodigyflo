'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, useTransition } from 'react'
import { ChevronRight, MessageSquareText, PhoneIncoming, PhoneMissed, PhoneOutgoing, Play, Send, Voicemail, X } from 'lucide-react'
import { loadMoreHistory } from '@/lib/call-center/history-actions'
import { durationLabel, type HistoryFilter, type HistoryRow, type HistoryRowKind } from '@/lib/call-center/history-format'
import { phoneText } from '@/lib/call-center/phone-display'
import './history.css'

const KIND: Record<HistoryRowKind, { label: string; Icon: typeof Play }> = {
  out: { label: 'Outgoing', Icon: PhoneOutgoing },
  in: { label: 'Incoming', Icon: PhoneIncoming },
  missed: { label: 'Missed', Icon: PhoneMissed },
  voicemail: { label: 'Voicemail', Icon: Voicemail },
  'sms-in': { label: 'Text in', Icon: MessageSquareText },
  'sms-out': { label: 'Text out', Icon: Send },
}

const SPEEDS = [1, 1.5, 2] as const

/** One recording at a time: opening another row's player unmounts this one, which stops it. */
function InlinePlayer({ src, rate, onRate, name }: { src: string; rate: number; onRate: (r: number) => void; name: string }) {
  const ref = useRef<HTMLAudioElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (ref.current) ref.current.playbackRate = rate
  }, [rate])
  if (failed) {
    // The route answers 404/503 when the carrier can't hand the file over: say so instead of a dead 0:00 player.
    return (
      <div className="hist-player">
        <p className="hist-player-error" role="status">This recording can&rsquo;t be played right now. Try again in a minute.</p>
      </div>
    )
  }
  return (
    <div className="hist-player">
      <audio
        ref={ref}
        controls
        autoPlay
        preload="auto"
        src={src}
        aria-label={`Recording, ${name}`}
        onLoadedMetadata={(e) => {
          e.currentTarget.playbackRate = rate
        }}
        onError={() => setFailed(true)}
      >
        <a href={src}>Download the recording</a>
      </audio>
      <div className="hist-speeds" role="group" aria-label="Playback speed">
        {SPEEDS.map((r) => (
          <button key={r} type="button" aria-pressed={rate === r} className={rate === r ? 'on' : undefined} onClick={() => onRate(r)}>
            {r}×
          </button>
        ))}
      </div>
    </div>
  )
}

function meta(row: HistoryRow): string {
  // The full number (or "Number unavailable") only reaches rows the viewer may see; never a tel: link.
  const phone = row.phone && phoneText(row.phone, null) !== row.name ? phoneText(row.phone, null) : null
  return [KIND[row.kind].label, `${row.day}, ${row.time}`, phone, row.rep, row.status].filter(Boolean).join(' · ')
}

/**
 * Calls & SMS rows. Server-rendered first page; "Load more" appends the next
 * 50 through a server action. The parent keys this on the filter and search,
 * so a new filter starts from a fresh first page.
 */
export function HistoryList({
  initial,
  nextCursor,
  filter,
  q,
  emptyText,
}: {
  initial: HistoryRow[]
  nextCursor: string | null
  filter: HistoryFilter
  q: string
  emptyText: string
}) {
  const [rows, setRows] = useState(initial)
  const [cursor, setCursor] = useState(nextCursor)
  const [playing, setPlaying] = useState<string | null>(null)
  const [rate, setRate] = useState(1)
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  function toggleText(key: string) {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function more() {
    if (!cursor) return
    setError(null)
    start(async () => {
      try {
        const page = await loadMoreHistory(filter, q, cursor)
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

  if (!rows.length) return <p className="hist-empty">{emptyText}</p>

  return (
    <>
      <ul className="hist-list">
        {rows.map((row) => {
          const { Icon } = KIND[row.kind]
          const sms = row.kind === 'sms-in' || row.kind === 'sms-out'
          const expanded = open.has(row.key)
          const isPlaying = playing === row.key
          const body = (
            <>
              <b className="hist-name">{row.name}</b>
              <span className="hist-meta">{meta(row)}</span>
              {sms && !expanded && row.text ? <span className="hist-snip">{row.text}</span> : null}
            </>
          )
          return (
            <li key={row.key} className={`hist-row k-${row.kind}${isPlaying ? ' playing' : ''}`}>
              <div className="hist-line">
                <span className="hist-ico" aria-hidden="true">
                  <Icon size={18} strokeWidth={2} />
                </span>
                {sms ? (
                  <button type="button" className="hist-main" aria-expanded={expanded} onClick={() => toggleText(row.key)}>
                    {body}
                  </button>
                ) : (
                  <div className="hist-main">{body}</div>
                )}
                <span className="hist-dur">{row.seconds ? durationLabel(row.seconds) : ''}</span>
                {row.recording ? (
                  <button
                    type="button"
                    className="hist-play"
                    aria-label={isPlaying ? `Close the recording of ${row.name}` : `Play the recording of ${row.name}`}
                    aria-expanded={isPlaying}
                    onClick={() => setPlaying(isPlaying ? null : row.key)}
                  >
                    {isPlaying ? <X size={18} /> : <Play size={18} fill="currentColor" />}
                  </button>
                ) : (
                  <span className="hist-play-none" aria-hidden="true" />
                )}
                {row.href ? (
                  <Link className="hist-go" href={row.href} aria-label={`Open ${row.name}`}>
                    <ChevronRight size={20} />
                  </Link>
                ) : (
                  <span className="hist-go none" aria-hidden="true" />
                )}
              </div>
              {sms && expanded ? <p className="hist-text">{row.text || 'No text.'}</p> : null}
              {isPlaying && row.recording ? (
                <>
                  <InlinePlayer src={row.recording.src} rate={rate} onRate={setRate} name={row.name} />
                  {row.transcript ? <p className="hist-text transcript">{row.transcript}</p> : null}
                </>
              ) : null}
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
