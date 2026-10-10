'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getVoiceToken } from '@/lib/telephony/actions'
import { EDGE_LABELS, type Edge, type EdgeResult, type MicReading, type Recommendation, type Verdict, recommend, testEdges } from '@/lib/telephony/quality'
import { MIC_PREF_KEY, storedDeviceId } from '@/lib/telephony/ui/audio-prefs'
import { measureMic, testEdge } from '@/lib/telephony/ui/connection-test'
import { actionFailure } from '@/lib/telephony/ui/result'
import { type LastTest, browserTimeZone, readLastTest, writeLastTest } from '@/lib/telephony/ui/voice-prefs'
import { useVoice } from './voice-provider'

const MIC_TEST_MS = 5_000

const VERDICT_STYLE: Record<Verdict, string> = {
  Excellent: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
  Good: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
  Fair: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  Poor: 'bg-red-500/15 text-red-700 dark:text-red-300',
  Failed: 'bg-red-500/15 text-red-700 dark:text-red-300',
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'mic'; level: number }
  | { kind: 'edge'; edge: Edge; index: number; total: number }
  | { kind: 'done'; full: boolean; rec: Recommendation; edges: EdgeResult[]; mic: MicReading | null; applied: boolean }
  | { kind: 'error'; message: string }

/**
 * "Test connection" in Phone settings, plus low-data mode.
 *
 * Quick test: one preflight call to the edge calls would use now (~10 s).
 * Full test: 5 s of microphone level, then up to 3 edges. `recommend()`
 * turns the numbers into a verdict and advice. A full test keeps its best
 * edge on its own (a quick test measures one edge, so it never moves it);
 * "Apply recommended" sets low-data mode. The provider hands both to the
 * Device, right away when idle.
 *
 * A preflight is a real (silent) call into the TwiML App; the server answers
 * it with a pause and a hang-up, so nothing ever rings anywhere.
 */
export function ConnectionTest() {
  const voice = useVoice()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  // Rendered only once someone opens Phone settings, never on the server (as
  // AudioSettings), so reading localStorage in the initializer is safe.
  const [last, setLast] = useState<LastTest | null>(() => readLastTest())
  const abortRef = useRef<AbortController | null>(null)

  // Closing the panel mid-test stops the test and releases the mic.
  useEffect(() => () => abortRef.current?.abort(), [])

  if (!voice) return null
  const { setup, status, connection, applyConnection } = voice
  const running = phase.kind === 'mic' || phase.kind === 'edge'
  const mock = setup.mode === 'mock'

  const run = async (full: boolean) => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    let mic: MicReading | null = null
    try {
      if (full) {
        setPhase({ kind: 'mic', level: -100 })
        const micId = await storedDeviceId(MIC_PREF_KEY, 'audioinput')
        mic = await measureMic(micId, MIC_TEST_MS, (level) => setPhase({ kind: 'mic', level }), ctrl.signal)
      }
      const res = await getVoiceToken()
      const failure = actionFailure(res)
      if (failure) throw new Error(failure.error)
      const token = (res as { token: string }).token
      const plan = full ? testEdges(browserTimeZone(), connection.measuredEdge) : connection.edges.slice(0, 1)
      const edges: EdgeResult[] = []
      for (const [index, edge] of plan.entries()) {
        if (ctrl.signal.aborted) return
        setPhase({ kind: 'edge', edge, index, total: plan.length })
        edges.push(await testEdge(token, edge, ctrl.signal))
      }
      if (ctrl.signal.aborted) return
      const rec = recommend({ edges, mic })
      // A full test is a measurement, and the measured edge beats the time
      // zone guess (contract §1), so it is kept without asking. Low-data mode
      // changes how calls sound, so that one waits for "Apply recommended".
      if (full && rec.bestEdge) applyConnection({ edge: rec.bestEdge })
      writeLastTest(full, rec)
      setLast(readLastTest())
      setPhase({ kind: 'done', full, rec, edges, mic, applied: false })
    } catch (err) {
      if (ctrl.signal.aborted) return
      setPhase({ kind: 'error', message: err instanceof Error && err.message ? err.message : 'The test did not finish. Try again.' })
    }
  }

  const stop = () => {
    abortRef.current?.abort()
    setPhase({ kind: 'idle' })
  }

  const apply = () => {
    if (phase.kind !== 'done') return
    applyConnection({ lowData: phase.rec.lowData })
    setPhase({ ...phase, applied: true })
  }

  // What "Apply recommended" would change, in words, so the button is never a mystery.
  const change =
    phase.kind === 'done' && phase.rec.verdict !== 'Failed' && phase.rec.lowData !== connection.lowData
      ? phase.rec.lowData
        ? 'turn on low-data mode'
        : 'turn off low-data mode'
      : null

  return (
    <div className="grid gap-2 border-t pt-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-sm sm:text-xs">Connection</span>
        {last && phase.kind === 'idle' && (
          <span className="text-muted-foreground truncate text-xs sm:text-[11px]">
            Last test: {last.verdict}
            {last.edge ? ` · ${EDGE_LABELS[last.edge]}` : ''}
          </span>
        )}
      </div>

      <label className="flex items-start gap-2 text-sm sm:text-xs">
        <input
          type="checkbox"
          className="mt-0.5 size-5 shrink-0 sm:size-auto"
          checked={connection.lowData}
          onChange={(e) => applyConnection({ lowData: e.target.checked })}
        />
        <span>
          Low-data mode
          <span className="text-muted-foreground block">Uses half the data. Clearer calls on weak Wi-Fi or a phone hotspot.</span>
        </span>
      </label>

      {mock ? (
        <p className="text-muted-foreground text-sm sm:text-xs">Test mode. There is no real connection to test.</p>
      ) : running ? (
        <div className="grid gap-1.5" aria-live="polite">
          <p className="flex items-center gap-1.5 text-sm sm:text-xs">
            <Loader2 className="size-3.5 animate-spin" />
            {phase.kind === 'mic'
              ? 'Listening to your microphone. Say a few words…'
              : `Testing ${EDGE_LABELS[phase.edge]}${phase.total > 1 ? ` (${phase.index + 1} of ${phase.total})` : ''}…`}
          </p>
          {phase.kind === 'mic' && (
            <div className="bg-muted h-1.5 overflow-hidden rounded-full" aria-hidden>
              <div
                className="h-full bg-emerald-500 transition-[width] duration-75"
                style={{ width: `${Math.min(100, Math.max(0, ((phase.level + 70) / 70) * 100))}%` }}
              />
            </div>
          )}
          <Button type="button" variant="outline" size="xs" className="h-11 justify-self-start px-4 text-sm sm:h-6 sm:px-2 sm:text-xs" onClick={stop}>
            Stop
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:gap-1.5">
          <Button type="button" variant="outline" size="xs" className="h-11 text-sm sm:h-6 sm:text-xs" onClick={() => void run(false)} disabled={status !== 'idle'}>
            Quick test
          </Button>
          <Button type="button" variant="outline" size="xs" className="h-11 text-sm sm:h-6 sm:text-xs" onClick={() => void run(true)} disabled={status !== 'idle'}>
            Full test (about 45 s)
          </Button>
        </div>
      )}

      {phase.kind === 'error' && (
        <p className="text-destructive text-sm sm:text-xs" role="alert">
          {phase.message}
        </p>
      )}

      {phase.kind === 'done' && (
        <div className="grid gap-1.5 rounded-md border p-2" aria-live="polite">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded-full px-2 py-0.5 text-xs sm:text-[11px] font-medium ${VERDICT_STYLE[phase.rec.verdict]}`}>
              {phase.rec.verdict === 'Failed' ? 'Could not connect' : phase.rec.verdict}
            </span>
            {phase.rec.measured && (
              <span className="text-muted-foreground text-xs sm:text-[11px] tabular-nums">
                {EDGE_LABELS[phase.rec.measured.edge]} · {phase.rec.measured.rttMs} ms
                {phase.rec.measured.lossPct !== null ? ` · ${phase.rec.measured.lossPct}% lost` : ''}
                {phase.rec.measured.mos !== null ? ` · MOS ${phase.rec.measured.mos}` : ''}
              </span>
            )}
          </div>
          {phase.mic && (
            <p className="text-muted-foreground text-xs sm:text-[11px]">
              Microphone: {phase.rec.micSilent ? 'too quiet' : phase.rec.micClipping ? 'too loud' : 'OK'}
            </p>
          )}
          <ul className="grid gap-1 text-sm sm:text-xs">
            {phase.rec.tips.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
          {phase.edges.some((e) => !e.ok && e.error) && (
            <ul className="text-muted-foreground grid gap-0.5 text-xs sm:text-[11px]">
              {phase.edges
                .filter((e) => !e.ok && e.error)
                .map((e) => (
                  <li key={e.edge}>{e.error}</li>
                ))}
            </ul>
          )}
          {phase.full && phase.rec.bestEdge && (
            <p className="text-muted-foreground text-xs sm:text-[11px]">Calls now connect through {EDGE_LABELS[phase.rec.bestEdge]}.</p>
          )}
          {phase.applied ? (
            <p className="text-sm sm:text-xs text-emerald-700 dark:text-emerald-400">Saved. The next call uses it.</p>
          ) : change ? (
            <Button type="button" size="xs" className="h-auto min-h-11 justify-self-start py-1 text-left whitespace-normal sm:min-h-0" onClick={apply}>
              Apply recommended: {change}
            </Button>
          ) : (
            phase.rec.verdict !== 'Failed' && <p className="text-muted-foreground text-sm sm:text-xs">Your settings already match.</p>
          )}
        </div>
      )}
    </div>
  )
}
