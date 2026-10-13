'use client'

import { useId, useState } from 'react'
import { formatWhen, type TrailEvent } from '@/lib/call-center/model'
import { RECORDINGS_SHOWN, RECORDINGS_STEP, trailWindow } from '@/lib/call-center/trail-window'
import { RecordingPlayer } from '@/components/voice/recording-player'

/**
 * A lead's Comms trail, oldest first. Only the newest three recordings (and
 * what happened after the oldest of them) show until the rep asks for more;
 * key it by lead id so each lead opens collapsed.
 */
export function CommsTrail({ trail }: { trail: TrailEvent[] }) {
  const [shown, setShown] = useState(RECORDINGS_SHOWN)
  const listId = useId()
  const { start, hiddenRecordings } = trailWindow(trail, shown)
  const expanded = shown > RECORDINGS_SHOWN
  return (
    <>
      {hiddenRecordings > 0 || expanded ? (
        <div className="trail-more">
          {hiddenRecordings > 0 ? (
            <button
              type="button"
              className="linkish"
              aria-controls={listId}
              aria-label={`Show ${Math.min(hiddenRecordings, RECORDINGS_STEP)} more of ${hiddenRecordings} earlier recordings`}
              onClick={() => setShown((count) => count + RECORDINGS_STEP)}
            >
              Show more ({hiddenRecordings})
            </button>
          ) : null}
          {expanded ? (
            <button type="button" className="linkish" aria-controls={listId} onClick={() => setShown(RECORDINGS_SHOWN)}>
              Show less
            </button>
          ) : null}
        </div>
      ) : null}
      <ol className="trail" id={listId}>
        {trail.slice(start).map((event, index) => (
          <li key={`${event.at}-${event.kind}-${start + index}`}>
            <time dateTime={event.at}>{formatWhen(event.at)}</time>
            <b>{event.label}</b>
            <div className="muted">{event.detail}</div>
            {event.recording ? (
              <RecordingPlayer src={event.recording.src} seconds={event.recording.seconds} className="mt-1.5" />
            ) : null}
            {event.recording?.transcript ? (
              <blockquote className="muted transcript">&ldquo;{event.recording.transcript}&rdquo;</blockquote>
            ) : null}
          </li>
        ))}
      </ol>
    </>
  )
}
