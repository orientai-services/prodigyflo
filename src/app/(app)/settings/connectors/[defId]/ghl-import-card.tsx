'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { CheckCircle2, DownloadCloud, KeyRound, Loader2, PauseCircle, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { GhlImportPhase, GhlPhaseCounts } from '@/lib/connectors/ghl'
import { runGhlImportAction } from '../actions'

/**
 * The Run/Resume island for the GoHighLevel pull importer. Each click starts a
 * loop that re-invokes the bounded server batch until it reports done,
 * rendering live counts between batches. All state that matters lives
 * server-side (Connector.config) — closing the page mid-import loses nothing;
 * the button comes back as "Resume import".
 */

export type GhlImportCardVM = {
  /** Both credential fields (token + location) are stored in the vault. */
  credsReady: boolean
  /** Persisted phase from the last batch — 'idle' when no import has run. */
  phase: GhlImportPhase | 'idle'
  contacts: GhlPhaseCounts
  opportunities: GhlPhaseCounts
  lastRunLabel: string | null
  lastError: string | null
}

/** Safety valve: ~8 pages × 100 records per batch → 300 batches ≈ 240k records. */
const MAX_BATCHES_PER_CLICK = 300

type Progress = {
  phase: GhlImportPhase | 'idle'
  contacts: GhlPhaseCounts
  opportunities: GhlPhaseCounts
}

function CountRow({ label, counts, active }: { label: string; counts: GhlPhaseCounts; active: boolean }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`w-24 shrink-0 font-medium ${active ? 'text-foreground' : 'text-muted-foreground'}`}>
        {label}
        {active && <Loader2 className="ml-1 inline size-3 animate-spin align-[-2px]" />}
      </span>
      <span className="text-success tabular-nums">{counts.imported} imported</span>
      <span className="text-muted-foreground tabular-nums">{counts.duplicates} duplicates</span>
      <span className={`tabular-nums ${counts.failed > 0 ? 'text-warning' : 'text-muted-foreground'}`}>
        {counts.failed} skipped
      </span>
    </div>
  )
}

export function GhlImportCard({ vm }: { vm: GhlImportCardVM }) {
  const router = useRouter()
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<Progress>({
    phase: vm.phase,
    contacts: vm.contacts,
    opportunities: vm.opportunities,
  })
  const stopRef = useRef(false)

  const resumable = progress.phase === 'contacts' || progress.phase === 'opportunities'
  const finished = progress.phase === 'done'

  const run = async () => {
    setRunning(true)
    stopRef.current = false
    try {
      for (let batch = 0; batch < MAX_BATCHES_PER_CLICK; batch++) {
        const res = await runGhlImportAction()
        if (!res.ok) {
          toast.error(res.error)
          return
        }
        setProgress({ phase: res.phase, contacts: res.contacts, opportunities: res.opportunities })
        if (res.done) {
          toast.success(res.message)
          router.refresh()
          return
        }
        if (stopRef.current) {
          toast.info('Import paused — progress is saved. Press Resume to continue.')
          return
        }
      }
      toast.info('Import paused after a long run — progress is saved. Press Resume to continue.')
    } finally {
      setRunning(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <DownloadCloud className="size-4" />
          Pull import
        </CardTitle>
        <CardDescription>
          Fetch every contact and opportunity from the GoHighLevel location into this account. Runs in small
          resumable batches; re-running is safe — already-imported records count as duplicates.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!vm.credsReady ? (
          <div className="text-muted-foreground flex items-start gap-2 text-sm">
            <KeyRound className="mt-0.5 size-4 shrink-0" />
            <span>
              Store the Private Integration token and Location ID in the Credentials card first — the import
              button unlocks once both are in the vault.
            </span>
          </div>
        ) : (
          <>
            {(resumable || finished || running) && (
              <div className="space-y-2 rounded-md border px-3 py-2">
                <CountRow
                  label="Contacts"
                  counts={progress.contacts}
                  active={running && progress.phase === 'contacts'}
                />
                <CountRow
                  label="Opportunities"
                  counts={progress.opportunities}
                  active={running && progress.phase === 'opportunities'}
                />
                {finished && !running && (
                  <p className="text-success flex items-center gap-1.5 text-xs">
                    <CheckCircle2 className="size-3.5" />
                    Import complete{vm.lastRunLabel ? ` — last run ${vm.lastRunLabel}` : ''}.
                  </p>
                )}
                {resumable && !running && (
                  <p className="text-warning flex items-center gap-1.5 text-xs">
                    <PauseCircle className="size-3.5" />
                    Paused mid-{progress.phase}{vm.lastRunLabel ? ` — last batch ${vm.lastRunLabel}` : ''}. Resume
                    picks up exactly where it stopped.
                  </p>
                )}
              </div>
            )}

            {vm.lastError && !running && (
              <p className="text-danger text-xs">{vm.lastError}</p>
            )}

            <div className="flex items-center gap-2">
              <Button size="sm" onClick={run} disabled={running}>
                {running ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />}
                {running ? 'Importing…' : resumable ? 'Resume import' : finished ? 'Run again' : 'Run import'}
              </Button>
              {running && (
                <Button variant="outline" size="sm" onClick={() => (stopRef.current = true)}>
                  Pause after this batch
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
