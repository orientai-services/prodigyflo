import { clockLabel } from '@/lib/telephony/ui/result'

/**
 * A call recording or voicemail, played through the app's own proxy
 * (`/api/voice/recordings/<voiceCallId>`), never a carrier URL.
 *
 * `preload="none"` on purpose: a timeline with twenty calls must not open
 * twenty authenticated streams just by rendering. The browser fetches only
 * when someone presses play, and the proxy answers byte ranges so scrubbing
 * works on iOS Safari too.
 */
export function RecordingPlayer({
  src,
  seconds,
  label,
  className,
}: {
  src: string
  seconds?: number | null
  label?: string
  className?: string
}) {
  return (
    <div className={['flex flex-wrap items-center gap-2', className].filter(Boolean).join(' ')}>
      <audio controls preload="none" src={src} className="h-10 w-full max-w-full min-w-0 basis-full sm:h-8 sm:w-auto sm:flex-1 sm:basis-auto">
        <a href={src}>Download the recording</a>
      </audio>
      <span className="text-muted-foreground text-xs tabular-nums whitespace-nowrap">
        {label ? `${label} · ` : ''}
        {seconds && seconds > 0 ? clockLabel(seconds) : 'Recording'}
      </span>
    </div>
  )
}
