'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  CheckCircle2,
  GitBranch,
  Loader2,
  Rocket,
  ServerCog,
  TerminalSquare,
  XCircle,
} from 'lucide-react'
import { dateTime, relativeTime } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState } from '@/components/empty-state'

export type DeployRunHistoryVM = {
  id: string
  status: string
  startedAt: string
  finishedAt: string | null
  startedByName: string
  commitHash: string | null
  summary: string | null
  durationSec: number | null
}

export type DeployConsoleVM = {
  mode: 'live' | 'mock'
  version: {
    branch: string
    localCommit: string | null
    originCommit: string | null
    builtAt: string | null
    inSync: boolean | null
  }
  service: { active: boolean | null; detail: string }
  currentRun: { id: string; startedAt: string } | null
  lastFinished: { id: string; status: string; finishedAt: string | null; commitHash: string | null } | null
  history: DeployRunHistoryVM[]
  opsCommands: { key: string; label: string; description: string }[]
}

const POLL_MS = 1500

function shortCommit(commit: string | null): string {
  return commit ? commit.slice(0, 8) : '—'
}

function statusBadge(status: string) {
  if (status === 'SUCCEEDED') {
    return (
      <Badge variant="outline" className="border-success/40 text-success">
        <CheckCircle2 /> Succeeded
      </Badge>
    )
  }
  if (status === 'FAILED') {
    return (
      <Badge variant="destructive">
        <XCircle /> Failed
      </Badge>
    )
  }
  return (
    <Badge variant="secondary">
      <Loader2 className="animate-spin" /> Running
    </Badge>
  )
}

/**
 * The interactive deploy console. All privileged work happens in the
 * /api/admin/deploy routes (isOwner + step-up re-checked on every call) — this
 * island only renders state, confirms intent, and polls the log by offset.
 */
export function DeployConsole({ vm }: { vm: DeployConsoleVM }) {
  const router = useRouter()

  // ── Deploy + log polling ──
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const [running, setRunning] = useState(vm.currentRun !== null)
  const [log, setLog] = useState('')
  const [outcome, setOutcome] = useState<'ok' | 'failed' | null>(null)
  const offsetRef = useRef(0)
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const logBoxRef = useRef<HTMLPreElement | null>(null)
  const refreshedRef = useRef(false)

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current)
      pollTimer.current = null
    }
  }, [])

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/deploy/log?offset=${offsetRef.current}`, {
        cache: 'no-store',
      })
      if (!res.ok) return
      const data = (await res.json()) as {
        content: string
        nextOffset: number
        run: { id: string; status: string } | null
      }
      if (data.content) {
        offsetRef.current = data.nextOffset
        setLog((prev) => prev + data.content)
      }
      const finished = data.run !== null && data.run.status !== 'RUNNING'
      if (finished) {
        stopPolling()
        setRunning(false)
        setOutcome(data.run!.status === 'SUCCEEDED' ? 'ok' : 'failed')
        if (!refreshedRef.current) {
          refreshedRef.current = true
          router.refresh()
        }
      }
    } catch {
      // transient network hiccup — the next tick retries
    }
  }, [router, stopPolling])

  const beginPolling = useCallback(() => {
    stopPolling()
    refreshedRef.current = false
    void poll()
    pollTimer.current = setInterval(() => void poll(), POLL_MS)
  }, [poll, stopPolling])

  // Resume watching a deploy that was already running when the page loaded.
  useEffect(() => {
    if (vm.currentRun) beginPolling()
    return stopPolling
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-scroll the log viewer as lines stream in.
  useEffect(() => {
    const box = logBoxRef.current
    if (box) box.scrollTop = box.scrollHeight
  }, [log])

  const startDeploy = async () => {
    setStarting(true)
    try {
      const res = await fetch('/api/admin/deploy', { method: 'POST' })
      const data = (await res.json().catch(() => ({}))) as {
        runId?: string
        error?: string
        stepUpRequired?: boolean
      }
      if (!res.ok) {
        if (data.stepUpRequired) {
          toast.error('Your password check expired — reload the page to confirm again.')
        } else {
          toast.error(data.error ?? 'Could not start the deploy.')
        }
        return
      }
      setConfirmOpen(false)
      setLog('')
      setOutcome(null)
      offsetRef.current = 0
      setRunning(true)
      toast.success('Deploy started.')
      beginPolling()
    } catch {
      toast.error('Could not reach the deploy endpoint.')
    } finally {
      setStarting(false)
    }
  }

  // ── Ops console ──
  const [opsOutput, setOpsOutput] = useState('')
  const [opsBusy, setOpsBusy] = useState<string | null>(null)
  const opsBoxRef = useRef<HTMLPreElement | null>(null)

  useEffect(() => {
    const box = opsBoxRef.current
    if (box) box.scrollTop = box.scrollHeight
  }, [opsOutput])

  const runOps = async (key: string, label: string) => {
    setOpsBusy(key)
    try {
      const res = await fetch('/api/admin/deploy/ops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: key }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        output?: string
        ok?: boolean
        mode?: string
        error?: string
        stepUpRequired?: boolean
      }
      if (!res.ok) {
        toast.error(
          data.stepUpRequired
            ? 'Your password check expired — reload the page to confirm again.'
            : (data.error ?? 'Command failed.'),
        )
        return
      }
      const stamp = new Date().toLocaleTimeString()
      setOpsOutput(
        (prev) =>
          `${prev}$ ${label.toLowerCase()}  ·  ${stamp}${data.ok ? '' : '  ·  exited nonzero'}\n${data.output ?? ''}\n\n`,
      )
    } catch {
      toast.error('Could not reach the ops endpoint.')
    } finally {
      setOpsBusy(null)
    }
  }

  const { version, service } = vm
  const behind = version.inSync === false
  const deployDisabled = running || starting

  return (
    <div className="space-y-4">
      {/* ── Header strip: version, service, last outcome, deploy button ── */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 py-4">
          <div className="flex items-center gap-2">
            <GitBranch className="text-muted-foreground size-4" />
            <div>
              <div className="font-mono text-sm">
                {shortCommit(version.localCommit)}
                <span className="text-muted-foreground"> live</span>
                <span className="text-muted-foreground mx-1.5">·</span>
                {shortCommit(version.originCommit)}
                <span className="text-muted-foreground"> origin/{version.branch}</span>
              </div>
              <div className="text-muted-foreground text-xs">
                {version.builtAt ? `built ${relativeTime(version.builtAt)}` : 'build time unknown'}
              </div>
            </div>
            {version.inSync === true && (
              <Badge variant="outline" className="border-success/40 text-success">
                Up to date
              </Badge>
            )}
            {behind && <Badge variant="secondary">Origin differs</Badge>}
            {version.inSync === null && <Badge variant="ghost">Sync unknown</Badge>}
          </div>

          <div className="flex items-center gap-2">
            <ServerCog className="text-muted-foreground size-4" />
            <span className="text-sm">Service</span>
            {service.active === true ? (
              <Badge variant="outline" className="border-success/40 text-success">
                {service.detail || 'active'}
              </Badge>
            ) : service.active === false ? (
              <Badge variant="destructive">{service.detail || 'inactive'}</Badge>
            ) : (
              <Badge variant="ghost">unknown</Badge>
            )}
          </div>

          {vm.lastFinished && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Last deploy</span>
              {statusBadge(vm.lastFinished.status)}
              {vm.lastFinished.finishedAt && (
                <span className="text-muted-foreground text-xs">
                  {relativeTime(vm.lastFinished.finishedAt)}
                </span>
              )}
            </div>
          )}

          {vm.mode === 'mock' && <Badge variant="secondary">Mock mode — no real commands run</Badge>}

          <div className="ms-auto">
            <Button onClick={() => setConfirmOpen(true)} disabled={deployDisabled}>
              {running ? <Loader2 className="animate-spin" /> : <Rocket />}
              {running ? 'Deploying…' : 'Deploy latest'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Live log viewer ── */}
      {(running || log || outcome) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              Deploy log
              {running && <Loader2 className="text-muted-foreground size-4 animate-spin" />}
              {outcome === 'ok' && (
                <Badge variant="outline" className="border-success/40 text-success">
                  <CheckCircle2 /> DEPLOY_OK
                </Badge>
              )}
              {outcome === 'failed' && (
                <Badge variant="destructive">
                  <XCircle /> Failed
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              Streaming from the server by offset — the service restarts itself near the end, so a
              brief gap in the stream is normal.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre
              ref={logBoxRef}
              className="bg-muted/50 max-h-80 overflow-x-auto overflow-y-auto rounded-md border p-3 font-mono text-xs leading-5 whitespace-pre-wrap"
            >
              {log || 'Waiting for the first log lines…'}
            </pre>
          </CardContent>
        </Card>
      )}

      {/* ── History ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Deploy history</CardTitle>
          <CardDescription>Every deploy started from this console, newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {vm.history.length === 0 ? (
            <EmptyState
              title="No deploys yet"
              description="The first deploy started from this console will appear here."
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Started</TableHead>
                    <TableHead>By</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Commit</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Summary</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {vm.history.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell className="whitespace-nowrap">{dateTime(run.startedAt)}</TableCell>
                      <TableCell className="whitespace-nowrap">{run.startedByName}</TableCell>
                      <TableCell>{statusBadge(run.status)}</TableCell>
                      <TableCell className="font-mono text-xs">{shortCommit(run.commitHash)}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {run.durationSec !== null ? `${run.durationSec}s` : '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground max-w-80 truncate text-xs">
                        {run.summary ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Read-only ops console ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <TerminalSquare className="size-4" /> Ops console
          </CardTitle>
          <CardDescription>
            Read-only server checks — a fixed allowlist, nothing free-form. Seeding, tests and web
            server config are deliberately not available here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {vm.opsCommands.map((cmd) => (
              <Button
                key={cmd.key}
                variant="outline"
                size="sm"
                disabled={opsBusy !== null}
                onClick={() => void runOps(cmd.key, cmd.label)}
                title={cmd.description}
              >
                {opsBusy === cmd.key && <Loader2 className="animate-spin" />}
                {cmd.label}
              </Button>
            ))}
          </div>
          {opsOutput && (
            <pre
              ref={opsBoxRef}
              className="bg-muted/50 max-h-64 overflow-x-auto overflow-y-auto rounded-md border p-3 font-mono text-xs leading-5 whitespace-pre-wrap"
            >
              {opsOutput}
            </pre>
          )}
        </CardContent>
      </Card>

      {/* ── Confirm dialog ── */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deploy to production?</DialogTitle>
            <DialogDescription>
              This builds and ships origin/{version.branch} to the live server, then restarts the
              service — expect a few seconds of downtime near the end.
              {vm.mode === 'mock' && ' (Mock mode: a simulated deploy log, no real commands.)'}
            </DialogDescription>
          </DialogHeader>
          <div className="text-muted-foreground space-y-1 font-mono text-xs">
            <div>live&nbsp;&nbsp;&nbsp;{shortCommit(version.localCommit)}</div>
            <div>origin&nbsp;{shortCommit(version.originCommit)}</div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={starting}>
              Cancel
            </Button>
            <Button onClick={() => void startDeploy()} disabled={starting}>
              {starting ? <Loader2 className="animate-spin" /> : <Rocket />}
              Deploy now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
