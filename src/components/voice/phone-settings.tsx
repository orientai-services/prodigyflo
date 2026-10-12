'use client'

import { AudioSettings } from './audio-settings'
import { ConnectionTest } from './connection-test'
import { useVoice } from './voice-provider'

/**
 * Phone settings: the line calls go out from, ringtone, microphone and
 * speaker, Test connection, and the recording notice. Shared by the Call
 * Center's phone pill and the call bar (its gear beside a dial error), so
 * both always offer the same controls. Rendered only after someone opens it, never on the
 * server (AudioSettings and ConnectionTest read the browser).
 */
export function PhoneSettings() {
  const voice = useVoice()
  if (!voice) return null
  const { setup } = voice

  return (
    <div className="grid gap-3">
      {(setup.voiceLimited || setup.mode === 'mock') && (
        <div className="flex flex-wrap gap-1.5">
          {setup.voiceLimited && (
            <span
              className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-300"
              title="One call at a time until Twilio approves the business profile."
            >
              One call at a time
            </span>
          )}
          {setup.mode === 'mock' && (
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[11px]">
              Test mode. No real calls are placed.
            </span>
          )}
        </div>
      )}
      {setup.canPickLine && setup.lines.length > 0 && (
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground text-xs">Call from</span>
          <select
            className="border-input bg-background h-11 rounded-md border px-2 text-base sm:h-8 sm:text-sm"
            value={voice.lineId ?? ''}
            onChange={(e) => voice.setLineId(e.target.value)}
            aria-label="Call from"
          >
            {setup.lines.map((line) => (
              <option key={line.id} value={line.id}>
                {line.label ? `${line.label} · ${line.display}` : line.display}
              </option>
            ))}
          </select>
        </label>
      )}
      {!setup.canPickLine && setup.lines.length > 0 && (
        <p className="text-muted-foreground text-xs">
          Calls go out from {setup.lines.find((l) => l.id === voice.lineId)?.display ?? setup.lines[0].display}.
        </p>
      )}
      {setup.lines.length === 0 && <p className="text-muted-foreground text-xs">This account has no phone line yet.</p>}
      {voice.leader && (
        <label className="flex items-start gap-2 text-sm sm:text-xs">
          <input
            type="checkbox"
            className="mt-0.5 size-5 shrink-0 sm:size-auto"
            checked={voice.ringtoneMuted}
            onChange={(e) => voice.setRingtoneMuted(e.target.checked)}
          />
          <span>
            Mute the ringtone
            <span className="text-muted-foreground block">Incoming calls still show on screen.</span>
          </span>
        </label>
      )}
      <AudioSettings />
      <ConnectionTest />
      {setup.recordOutbound && (
        <p className="text-muted-foreground text-xs">
          Calls are recorded. People hear &ldquo;This call may be recorded&rdquo; when they answer.
        </p>
      )}
    </div>
  )
}
