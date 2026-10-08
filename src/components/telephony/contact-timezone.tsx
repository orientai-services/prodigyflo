'use client'

import { useState, useTransition } from 'react'
import { Loader2 } from 'lucide-react'
import { setContactTimeZone } from '@/lib/telephony/actions'
import type { DialTarget } from '@/lib/telephony/voice-contract'
import { actionFailure, thrownMessage } from '@/lib/telephony/ui/result'

/**
 * Shown when the server answers UNKNOWN_TIMEZONE. That block is never
 * overridable: the only way past it is for someone to write down where the
 * person actually is ("they told us they're in Phoenix"). The server audits
 * the change with the note, so the note is required.
 */
const ZONES: { id: string; label: string }[] = [
  { id: 'America/New_York', label: 'Eastern' },
  { id: 'America/Chicago', label: 'Central' },
  { id: 'America/Denver', label: 'Mountain' },
  { id: 'America/Phoenix', label: 'Arizona (no daylight saving)' },
  { id: 'America/Los_Angeles', label: 'Pacific' },
  { id: 'America/Anchorage', label: 'Alaska' },
  { id: 'Pacific/Honolulu', label: 'Hawaii' },
  { id: 'America/Puerto_Rico', label: 'Puerto Rico' },
  { id: 'America/Mexico_City', label: 'Mexico (central)' },
  { id: 'America/Bogota', label: 'Colombia, Peru, Ecuador' },
]

export function ContactTimezone({
  target,
  onSaved,
}: {
  target: DialTarget
  onSaved?: () => void
}) {
  const [pending, startTransition] = useTransition()
  const [zone, setZone] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const save = () => {
    setError(null)
    startTransition(async () => {
      try {
        const res = await setContactTimeZone({ target, zone, note: note.trim() })
        const failure = actionFailure(res)
        if (failure) {
          setError(failure.error)
          return
        }
        setSaved(true)
        onSaved?.()
      } catch (err) {
        setError(thrownMessage(err))
      }
    })
  }

  if (saved) return <p className="text-muted-foreground text-xs">Time zone saved. Check the call again.</p>

  return (
    <div className="mt-2 grid gap-2 text-sm">
      <label className="grid gap-1">
        <span className="text-muted-foreground text-xs">Where are they?</span>
        <select
          className="border-input bg-background h-8 rounded-md border px-2 text-sm"
          value={zone}
          onChange={(e) => setZone(e.target.value)}
          aria-label="Their time zone"
        >
          <option value="">Pick a time zone</option>
          {ZONES.map((z) => (
            <option key={z.id} value={z.id}>
              {z.label}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1">
        <span className="text-muted-foreground text-xs">How do you know?</span>
        <input
          className="border-input bg-background h-8 rounded-md border px-2 text-sm"
          value={note}
          maxLength={200}
          placeholder="They told us on the phone"
          onChange={(e) => setNote(e.target.value)}
          aria-label="How do you know their time zone"
        />
      </label>
      {error && (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
      <div>
        <button
          type="button"
          className="bg-primary text-primary-foreground inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium disabled:opacity-50"
          disabled={pending || !zone || !note.trim()}
          onClick={save}
        >
          {pending && <Loader2 className="size-3.5 animate-spin" />}
          Save time zone
        </button>
      </div>
    </div>
  )
}
