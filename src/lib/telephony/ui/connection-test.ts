import { type Edge, type EdgeResult, type MicFrame, type MicReading, type PreflightReportLike, EDGE_LABELS, dbfs, edgeResultFromReport, summarizeMicFrames } from '@/lib/telephony/quality'

/**
 * The browser half of "Test connection": a 5-second microphone level check
 * and Twilio preflight calls to one or more edges. Browser-only; the numbers
 * go to `recommend()` in quality.ts, which owns every threshold.
 *
 * Both parts take the microphone only for the test and release it at the
 * end, so the "mic only during a call" rule (voice-provider.tsx) still holds
 * outside an explicit test the rep started.
 */

// The small slice of the SDK used here, typed locally so the SDK stays a
// dynamic import (same reason as voice-provider.tsx).
type Preflight = {
  on(event: 'completed', fn: (report: PreflightReportLike) => void): unknown
  on(event: 'failed', fn: (err: unknown) => void): unknown
  stop(): void
}
type PreflightSdk = { Device: { runPreflight(token: string, options: Record<string, unknown>): Preflight } }

/** One preflight takes ~8 s of call (the server's Pause) plus setup; give up well after. */
const EDGE_TIMEOUT_MS = 30_000

function failed(edge: Edge, error: string): EdgeResult {
  return { edge, ok: false, rttMs: null, jitterMs: null, lossPct: null, mos: null, turn: null, bandwidthBad: false, error }
}

function preflightError(edge: Edge, err: unknown): string {
  const e = err as { code?: number; name?: string } | null
  if (e?.name === 'NotAllowedError' || e?.code === 31401 || e?.code === 31208) return 'Allow the microphone to run the test.'
  if (e?.code === 31008) return 'The test was stopped.'
  if (e?.code === 20101 || e?.code === 20104) return 'Your phone session expired. Reload the page.'
  return `Couldn't connect to ${EDGE_LABELS[edge]}${typeof e?.code === 'number' ? ` (code ${e.code})` : ''}.`
}

/** One preflight call to one edge. Never throws; a failure comes back as `ok: false`. */
export async function testEdge(token: string, edge: Edge, signal?: AbortSignal): Promise<EdgeResult> {
  let sdk: PreflightSdk
  try {
    sdk = (await import('@twilio/voice-sdk')) as unknown as PreflightSdk
  } catch {
    return failed(edge, 'Could not load the phone. Reload the page and try again.')
  }
  if (signal?.aborted) return failed(edge, 'The test was stopped.')
  return new Promise<EdgeResult>((resolve) => {
    let done = false
    let test: Preflight | null = null
    const finish = (result: EdgeResult) => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve(result)
    }
    const abort = () => {
      try {
        test?.stop()
      } catch {
        // Already finished.
      }
      finish(failed(edge, 'The test was stopped.'))
    }
    const timer = window.setTimeout(() => {
      try {
        test?.stop()
      } catch {
        // Already finished.
      }
      finish(failed(edge, `${EDGE_LABELS[edge]} didn't answer in time.`))
    }, EDGE_TIMEOUT_MS)
    signal?.addEventListener('abort', abort)
    try {
      // Opus first, as on real calls, so the numbers match what a call gets.
      const started = sdk.Device.runPreflight(token, { edge, codecPreferences: ['opus', 'pcmu'] })
      test = started
      started.on('completed', (report) => finish(edgeResultFromReport(edge, report)))
      started.on('failed', (err) => finish(failed(edge, preflightError(edge, err))))
    } catch (err) {
      finish(failed(edge, preflightError(edge, err)))
    }
  })
}

/**
 * Listen to the microphone for `ms` and summarise its level. `onLevel` gets
 * the live dBFS for a meter. Throws a plain-words Error when the mic can't be
 * opened; always stops the track it opened.
 */
export async function measureMic(
  deviceId: string | null,
  ms: number,
  onLevel?: (db: number) => void,
  signal?: AbortSignal,
): Promise<MicReading> {
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
  if (!media?.getUserMedia) throw new Error("This browser can't test the microphone.")
  let stream: MediaStream
  try {
    stream = await media.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true })
  } catch (err) {
    const name = (err as { name?: string } | null)?.name
    if (name === 'NotAllowedError') throw new Error('Allow the microphone to run the test.')
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new Error('That microphone is not plugged in. Pick another one above.')
    throw new Error("Couldn't open the microphone.")
  }
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  const ctx = new Ctx()
  const frames: MicFrame[] = []
  try {
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    source.connect(analyser)
    const buf = new Float32Array(analyser.fftSize)
    await new Promise<void>((resolve) => {
      const started = Date.now()
      const tick = window.setInterval(() => {
        analyser.getFloatTimeDomainData(buf)
        let sum = 0
        let peak = 0
        for (let i = 0; i < buf.length; i++) {
          const v = buf[i]
          sum += v * v
          const a = Math.abs(v)
          if (a > peak) peak = a
        }
        const rms = Math.sqrt(sum / buf.length)
        frames.push({ rms, peak })
        onLevel?.(dbfs(rms))
        if (Date.now() - started >= ms || signal?.aborted) {
          window.clearInterval(tick)
          resolve()
        }
      }, 50)
    })
  } finally {
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close().catch(() => {})
  }
  if (signal?.aborted) throw new Error('The test was stopped.')
  return summarizeMicFrames(frames)
}
