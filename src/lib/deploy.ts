import 'server-only'
import { execFile, spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, writeSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { db } from '@/lib/db'
import type { SessionUser } from '@/lib/rbac'

/**
 * Deploy console backend — owner-only, step-up-gated (the routes under
 * /api/admin/deploy enforce both; nothing here is reachable from the client
 * directly).
 *
 * Security model:
 * - Commands are EXACT allowlisted argv arrays executed via execFile/spawn —
 *   never a shell, and never any string interpolation of user-supplied input.
 *   The only caller-controlled value is an allowlist KEY looked up here.
 * - The deploy script is launched DETACHED with stdio bound to the log file,
 *   because deploy.sh runs `systemctl restart prodigyflo` and kills the very
 *   process that launched it. On systemd hosts we prefer `systemd-run` so the
 *   child escapes the service cgroup (a merely-detached child would still die
 *   with the unit); plain detached bash is the fallback.
 * - Because the launcher dies mid-deploy, the RUNNING DeployRun row cannot be
 *   finalized by the launching process. Instead every read path reconciles:
 *   DEPLOY_OK in the log ⇒ SUCCEEDED, a log gone quiet ⇒ FAILED.
 * - Concurrency: a flock-style lockfile (O_EXCL create) next to the log plus
 *   a RUNNING DeployRun row; either one refuses a second deploy.
 * - On non-Linux/dev hosts every command degrades to a labelled mock result so
 *   the console is fully demoable locally.
 *
 * Env (all optional, sane droplet defaults):
 *   DEPLOY_SCRIPT   path to deploy.sh            (default /opt/prodigyflo/deploy.sh)
 *   DEPLOY_LOG      deploy log file              (default /opt/prodigyflo/deploy.log)
 *   DEPLOY_REPO_DIR git clone for origin lookups (default /opt/prodigyflo/repo)
 */

const SERVICE = 'prodigyflo'
const BRANCH = 'p0-mvp'

export const LOG_WINDOW_BYTES = 64 * 1024
/** A deploy whose log stopped growing for this long is considered dead. */
export const DEPLOY_STALL_MS = 10 * 60_000
/** Never stall-fail a deploy younger than this (npm ci can be slow to print). */
export const DEPLOY_MIN_RUNTIME_MS = 2 * 60_000
/** Absolute ceiling — a RUNNING row older than this is failed regardless. */
export const DEPLOY_TIMEOUT_MS = 30 * 60_000
/** A lockfile older than this belongs to a dead deploy and may be broken. */
export const LOCK_STALE_MS = 30 * 60_000

export type DeployMode = 'live' | 'mock'

// ─── Read-only ops allowlist ─────────────────────────────────────────────────
// The ONLY commands the ops console can run. Exact argv arrays; the client
// sends a key, never an argument. Deliberately absent: seed, vitest, reports
// build, anything that writes nginx config.

export type OpsCommandKey = 'status' | 'journal' | 'disk' | 'memory' | 'migrate-status'

export type OpsSpec = {
  key: OpsCommandKey
  label: string
  description: string
  argv: readonly string[]
  /** 'app' → run in the app working directory (needed for prisma). */
  cwd?: 'app'
}

const OPS_COMMANDS: readonly OpsSpec[] = Object.freeze(
  (
    [
      {
        key: 'status',
        label: 'Service status',
        description: 'systemctl is-active — is the app unit running?',
        argv: Object.freeze(['systemctl', 'is-active', SERVICE]),
      },
      {
        key: 'journal',
        label: 'Journal tail',
        description: 'Last 80 lines of the app service journal.',
        argv: Object.freeze(['journalctl', '-u', SERVICE, '-n', '80', '--no-pager', '--output', 'short-iso']),
      },
      {
        key: 'disk',
        label: 'Disk usage',
        description: 'df -h across mounted filesystems.',
        argv: Object.freeze(['df', '-h']),
      },
      {
        key: 'memory',
        label: 'Memory',
        description: 'free -m — RAM and swap in megabytes.',
        argv: Object.freeze(['free', '-m']),
      },
      {
        key: 'migrate-status',
        label: 'Migrate status',
        description: 'prisma migrate status — pending migrations, if any.',
        argv: Object.freeze(['npx', 'prisma', 'migrate', 'status']),
        cwd: 'app',
      },
    ] satisfies OpsSpec[]
  ).map((s) => Object.freeze(s)),
)

/** Exact-key lookup into the allowlist. Anything else → null (route answers 400). */
export function opsCommand(key: string): OpsSpec | null {
  return OPS_COMMANDS.find((c) => c.key === key) ?? null
}

/** Serializable command list for the console UI (no argv — the key is the contract). */
export function listOpsCommands(): { key: OpsCommandKey; label: string; description: string }[] {
  return OPS_COMMANDS.map(({ key, label, description }) => ({ key, label, description }))
}

const MOCK_OPS_OUTPUT: Record<OpsCommandKey, string> = {
  status: '[mock] active',
  journal: [
    '[mock] 2026-08-28T09:00:01+0000 prodigyflo systemd[1]: Started ProdigyFlo (Sales Client Overview).',
    '[mock] 2026-08-28T09:00:06+0000 prodigyflo npx[4242]:   ▲ Next.js ready on http://127.0.0.1:3050',
    '[mock] 2026-08-28T09:05:12+0000 prodigyflo npx[4242]: GET /dashboard 200 in 84ms',
  ].join('\n'),
  disk: [
    '[mock] Filesystem      Size  Used Avail Use% Mounted on',
    '[mock] /dev/vda1        78G   22G   56G  29% /',
  ].join('\n'),
  memory: [
    '[mock]                total        used        free      shared  buff/cache   available',
    '[mock] Mem:            7937        2411        3180          12        2345        5233',
    '[mock] Swap:              0           0           0',
  ].join('\n'),
  'migrate-status': '[mock] Database schema is up to date — no pending migrations.',
}

// ─── Pure helpers (unit-tested in deploy.test.ts) ────────────────────────────

/**
 * Clamp an offset-based read window against the current file size.
 * Bad offsets (negative, NaN, past EOF) degrade safely; `eof` tells the poller
 * whether another slice remains right now.
 */
export function clampLogWindow(
  fileSize: number,
  offset: number,
  maxBytes: number = LOG_WINDOW_BYTES,
): { start: number; length: number; nextOffset: number; eof: boolean } {
  const size = Number.isFinite(fileSize) && fileSize > 0 ? Math.floor(fileSize) : 0
  const rawOffset = Number.isFinite(offset) ? Math.floor(offset) : 0
  const start = Math.min(Math.max(rawOffset, 0), size)
  const length = Math.min(size - start, Math.max(0, Math.floor(maxBytes)))
  const nextOffset = start + length
  return { start, length, nextOffset, eof: nextOffset >= size }
}

/**
 * Decide the fate of a RUNNING deploy from its log:
 * - `DEPLOY_OK` on its own line (deploy.sh's final echo) ⇒ SUCCEEDED.
 * - Log silent for DEPLOY_STALL_MS after a minimum runtime ⇒ FAILED
 *   (set -euo pipefail dies without a marker — silence IS the failure signal).
 * - Older than the absolute timeout ⇒ FAILED.
 * - Otherwise null: still running.
 */
export function detectDeployOutcome(input: {
  logText: string
  startedAtMs: number
  lastLogWriteMs: number | null
  nowMs: number
}): 'SUCCEEDED' | 'FAILED' | null {
  if (/(^|\n)DEPLOY_OK\s*(\r?\n|$)/.test(input.logText)) return 'SUCCEEDED'
  const runtime = input.nowMs - input.startedAtMs
  if (runtime > DEPLOY_TIMEOUT_MS) return 'FAILED'
  if (
    runtime > DEPLOY_MIN_RUNTIME_MS &&
    input.lastLogWriteMs !== null &&
    input.nowMs - input.lastLogWriteMs > DEPLOY_STALL_MS
  ) {
    return 'FAILED'
  }
  return null
}

/** A lockfile this old belongs to a deploy that died without cleanup. */
export function isLockStale(lockMtimeMs: number, nowMs: number): boolean {
  return nowMs - lockMtimeMs > LOCK_STALE_MS
}

/**
 * The exact argv used to launch the deploy script. With systemd-run the child
 * runs in its own transient unit (outside our service cgroup, so
 * `systemctl restart prodigyflo` cannot kill it) and systemd appends its
 * output to the log; the fallback relies on detached spawn + stdio-to-logfile.
 * Both paths take operator-config paths only — never user input.
 */
export function buildDeployArgv(
  script: string,
  logPath: string,
  opts: { systemdRun: boolean },
): string[] {
  if (opts.systemdRun) {
    return [
      'systemd-run',
      '--unit=prodigyflo-deploy',
      '--collect',
      `--property=StandardOutput=append:${logPath}`,
      `--property=StandardError=append:${logPath}`,
      '/bin/bash',
      script,
    ]
  }
  return ['/bin/bash', script]
}

// ─── Config ──────────────────────────────────────────────────────────────────

function cfg(): { script: string; log: string; repoDir: string; mode: DeployMode } {
  const isLinux = process.platform === 'linux'
  const script = process.env.DEPLOY_SCRIPT ?? '/opt/prodigyflo/deploy.sh'
  const log =
    process.env.DEPLOY_LOG ??
    (isLinux ? '/opt/prodigyflo/deploy.log' : path.join(os.tmpdir(), 'prodigyflo-deploy.log'))
  const repoDir = process.env.DEPLOY_REPO_DIR ?? '/opt/prodigyflo/repo'
  // Live only on a Linux host that actually has the deploy script; everything
  // else (Windows dev, CI) demos through labelled mocks.
  const mode: DeployMode = isLinux && existsSync(script) ? 'live' : 'mock'
  return { script, log, repoDir, mode }
}

export function deployMode(): DeployMode {
  return cfg().mode
}

// ─── Process execution (allowlisted argv only) ───────────────────────────────

const pExecFile = promisify(execFile)

async function runArgv(
  argv: readonly string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await pExecFile(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 20_000,
      maxBuffer: 512 * 1024,
      windowsHide: true,
    })
    return { ok: true, output: [stdout, stderr].filter(Boolean).join('\n').trim() }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    const output =
      [err.stdout, err.stderr].filter(Boolean).join('\n').trim() || (err.message ?? 'Command failed.')
    return { ok: false, output }
  }
}

export type OpsResult = {
  key: OpsCommandKey
  label: string
  mode: DeployMode
  ok: boolean
  output: string
  tookMs: number
}

/** Run one allowlisted read-only command. Unknown key → null (caller answers 400). */
export async function runOpsCommand(key: string): Promise<OpsResult | null> {
  const spec = opsCommand(key)
  if (!spec) return null
  const { mode } = cfg()
  const t0 = Date.now()
  if (mode === 'mock') {
    return { key: spec.key, label: spec.label, mode, ok: true, output: MOCK_OPS_OUTPUT[spec.key], tookMs: Date.now() - t0 }
  }
  const res = await runArgv(spec.argv, { cwd: spec.cwd === 'app' ? process.cwd() : undefined })
  return { key: spec.key, label: spec.label, mode, ...res, tookMs: Date.now() - t0 }
}

// ─── Build / version info ────────────────────────────────────────────────────

type BuildInfo = { commit?: string; branch?: string; builtAt?: string }

/** deploy.sh stamps BUILD_INFO.json into the app root at every deploy. */
async function readBuildInfo(): Promise<BuildInfo | null> {
  try {
    const raw = await fsp.readFile(path.join(process.cwd(), 'BUILD_INFO.json'), 'utf8')
    const parsed = JSON.parse(raw) as BuildInfo
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

export type VersionInfo = {
  mode: DeployMode
  branch: string
  /** Commit the running build was made from (BUILD_INFO.json), short-friendly. */
  localCommit: string | null
  builtAt: string | null
  /** origin/<branch> HEAD after a fresh fetch, when the repo clone exists. */
  originCommit: string | null
  /** true = up to date, false = origin is ahead/different, null = unknown. */
  inSync: boolean | null
}

export async function getVersionInfo(): Promise<VersionInfo> {
  const { mode, repoDir } = cfg()
  const build = await readBuildInfo()
  if (mode === 'mock') {
    const commit = build?.commit && build.commit !== 'unknown' ? build.commit : 'd3m0c0de'
    return {
      mode,
      branch: BRANCH,
      localCommit: commit,
      builtAt: build?.builtAt ?? null,
      originCommit: commit,
      inSync: true,
    }
  }
  let originCommit: string | null = null
  if (existsSync(path.join(repoDir, '.git'))) {
    // Best-effort fetch (offline box must not break the page), then rev-parse.
    await runArgv(['git', '-C', repoDir, 'fetch', 'origin', BRANCH, '--quiet'], { timeoutMs: 15_000 })
    const rev = await runArgv(['git', '-C', repoDir, 'rev-parse', `origin/${BRANCH}`])
    if (rev.ok) originCommit = rev.output.split('\n')[0]?.trim() || null
  }
  const localCommit = build?.commit && build.commit !== 'unknown' ? build.commit : null
  return {
    mode,
    branch: BRANCH,
    localCommit,
    builtAt: build?.builtAt ?? null,
    originCommit,
    inSync: localCommit && originCommit ? originCommit.startsWith(localCommit) || localCommit.startsWith(originCommit) : null,
  }
}

// ─── Log file access ─────────────────────────────────────────────────────────

async function logStat(logPath: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const st = await fsp.stat(logPath)
    return { size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

async function readLogRange(logPath: string, start: number, length: number): Promise<string> {
  if (length <= 0) return ''
  let handle: fsp.FileHandle | null = null
  try {
    handle = await fsp.open(logPath, 'r')
    const buf = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buf, 0, length, start)
    return buf.subarray(0, bytesRead).toString('utf8')
  } catch {
    return ''
  } finally {
    await handle?.close().catch(() => {})
  }
}

// ─── Lockfile ────────────────────────────────────────────────────────────────

function lockPath(logFile: string): string {
  return `${logFile}.lock`
}

/** O_EXCL create — the flock-style mutual exclusion. Breaks only stale locks. */
async function acquireLock(runId: string): Promise<boolean> {
  const p = lockPath(cfg().log)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(p, 'wx')
      writeSync(fd, `${runId} pid=${process.pid} at=${new Date().toISOString()}\n`)
      closeSync(fd)
      return true
    } catch {
      const st = await fsp.stat(p).catch(() => null)
      if (st && isLockStale(st.mtimeMs, Date.now())) {
        await fsp.rm(p, { force: true }).catch(() => {})
        continue
      }
      return false
    }
  }
  return false
}

async function releaseLock(): Promise<void> {
  await fsp.rm(lockPath(cfg().log), { force: true }).catch(() => {})
}

// ─── Reconcile ───────────────────────────────────────────────────────────────

/**
 * Finalize RUNNING DeployRun rows from the log. The launching process is
 * killed by `systemctl restart` inside the deploy, so finalization must happen
 * on a later read — every status/log/history read calls this first.
 */
async function reconcileRunningDeploys(): Promise<void> {
  const running = await db.deployRun.findMany({ where: { status: 'RUNNING' } })
  if (running.length === 0) return
  const { log } = cfg()
  const st = await logStat(log)
  const win = clampLogWindow(st?.size ?? 0, Math.max(0, (st?.size ?? 0) - LOG_WINDOW_BYTES))
  const tail = st ? await readLogRange(log, win.start, win.length) : ''
  const now = Date.now()
  const build = await readBuildInfo()
  for (const row of running) {
    const outcome = detectDeployOutcome({
      logText: tail,
      startedAtMs: row.startedAt.getTime(),
      lastLogWriteMs: st?.mtimeMs ?? null,
      nowMs: now,
    })
    if (!outcome) continue
    // updateMany guards the status so a concurrent reconcile never double-writes.
    await db.deployRun.updateMany({
      where: { id: row.id, status: 'RUNNING' },
      data: {
        status: outcome,
        finishedAt: new Date(),
        commitHash: outcome === 'SUCCEEDED' ? (build?.commit ?? null) : null,
        summary:
          outcome === 'SUCCEEDED'
            ? 'DEPLOY_OK — new build is live.'
            : 'No DEPLOY_OK and the log went quiet — marked failed.',
      },
    })
    await releaseLock()
  }
}

// ─── Start deploy ────────────────────────────────────────────────────────────

export type StartDeployResult =
  | { ok: true; runId: string; mode: DeployMode }
  | { ok: false; error: string }

export async function startDeploy(user: SessionUser): Promise<StartDeployResult> {
  const { mode, script, log } = cfg()
  await reconcileRunningDeploys()

  const active = await db.deployRun.findFirst({ where: { status: 'RUNNING' }, select: { id: true } })
  if (active) return { ok: false, error: 'A deploy is already running — wait for it to finish.' }

  await fsp.mkdir(path.dirname(log), { recursive: true }).catch(() => {})

  const run = await db.deployRun.create({
    data: {
      organizationId: user.organizationId,
      startedById: user.id,
      status: 'RUNNING',
      logPath: log,
    },
    select: { id: true },
  })

  if (!(await acquireLock(run.id))) {
    await db.deployRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', finishedAt: new Date(), summary: 'Refused — another deploy holds the lock.' },
    })
    return { ok: false, error: 'Another deploy holds the lock — try again in a moment.' }
  }

  // Fresh log per deploy: truncate, then header. (Reconcile reads THIS file, so
  // a previous run's DEPLOY_OK must never linger.)
  const header = `── deploy started ${new Date().toISOString()} · mode=${mode} · run=${run.id} ──\n`
  try {
    await fsp.writeFile(log, header, 'utf8')
  } catch (e) {
    await db.deployRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', finishedAt: new Date(), summary: `Could not open the deploy log: ${(e as Error).message}` },
    })
    await releaseLock()
    return { ok: false, error: 'Could not open the deploy log file.' }
  }

  if (mode === 'mock') {
    // Fire-and-forget; the poller watches the log exactly like a live deploy.
    void runMockDeploy(run.id, log).catch(() => {})
    return { ok: true, runId: run.id, mode }
  }

  try {
    const systemdRun = existsSync('/usr/bin/systemd-run') || existsSync('/bin/systemd-run')
    const argv = buildDeployArgv(script, log, { systemdRun })
    const fd = openSync(log, 'a')
    const child = spawn(argv[0], argv.slice(1), {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: process.env,
    })
    child.unref()
    closeSync(fd)
  } catch (e) {
    await db.deployRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', finishedAt: new Date(), summary: `Launch failed: ${(e as Error).message}` },
    })
    await releaseLock()
    return { ok: false, error: 'Failed to launch the deploy script.' }
  }
  return { ok: true, runId: run.id, mode }
}

const MOCK_DEPLOY_LINES = [
  '[mock] source: git fetch (/opt/prodigyflo/repo, origin/p0-mvp)',
  '[mock] npm ci --no-audit --no-fund',
  '[mock] added 812 packages in 9s',
  '[mock] npx prisma migrate deploy — no pending migrations',
  '[mock] next build — creating an optimized production build…',
  '[mock] next build — compiled successfully',
  '[mock] seed skipped — database has data (orgs: 3)',
  '[mock] systemctl restart prodigyflo',
  '[mock] active',
  '[mock] nginx: configuration ok — reloaded',
] as const

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Deterministic labelled mock: streams a canned log, then DEPLOY_OK. */
async function runMockDeploy(runId: string, log: string): Promise<void> {
  try {
    for (const line of MOCK_DEPLOY_LINES) {
      await sleep(700)
      await fsp.appendFile(log, `${line}\n`, 'utf8')
    }
    await sleep(700)
    await fsp.appendFile(log, 'DEPLOY_OK\n', 'utf8')
    await db.deployRun.updateMany({
      where: { id: runId, status: 'RUNNING' },
      data: {
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        commitHash: 'd3m0c0de',
        summary: 'Mock deploy — no commands were executed on this host.',
      },
    })
  } catch {
    await db.deployRun.updateMany({
      where: { id: runId, status: 'RUNNING' },
      data: { status: 'FAILED', finishedAt: new Date(), summary: 'Mock deploy interrupted.' },
    })
  } finally {
    await releaseLock()
  }
}

// ─── Read paths (log slice, status, history) ─────────────────────────────────

export type DeployLogSlice = {
  mode: DeployMode
  offset: number
  nextOffset: number
  size: number
  content: string
  /** Latest run, so the poller knows when to stop. */
  run: { id: string; status: string; startedAt: string } | null
}

export async function readDeployLog(offset: number): Promise<DeployLogSlice> {
  await reconcileRunningDeploys()
  const { mode, log } = cfg()
  const st = await logStat(log)
  const win = clampLogWindow(st?.size ?? 0, offset)
  const content = st ? await readLogRange(log, win.start, win.length) : ''
  const latest = await db.deployRun.findFirst({
    orderBy: { startedAt: 'desc' },
    select: { id: true, status: true, startedAt: true },
  })
  return {
    mode,
    offset: win.start,
    nextOffset: win.nextOffset,
    size: st?.size ?? 0,
    content,
    run: latest ? { id: latest.id, status: latest.status, startedAt: latest.startedAt.toISOString() } : null,
  }
}

export type ServiceStatus = { mode: DeployMode; active: boolean | null; detail: string }

export async function getServiceStatus(): Promise<ServiceStatus> {
  const { mode } = cfg()
  if (mode === 'mock') return { mode, active: true, detail: 'active (mock)' }
  const res = await runArgv(['systemctl', 'is-active', SERVICE], { timeoutMs: 8_000 })
  return { mode, active: res.ok, detail: res.output || (res.ok ? 'active' : 'inactive') }
}

export type DeployRunVM = {
  id: string
  status: string
  startedAt: string
  finishedAt: string | null
  startedByName: string
  commitHash: string | null
  summary: string | null
  durationSec: number | null
}

export async function listDeployRuns(user: SessionUser, take = 20): Promise<DeployRunVM[]> {
  await reconcileRunningDeploys()
  const rows = await db.deployRun.findMany({
    where: { organizationId: user.organizationId },
    orderBy: { startedAt: 'desc' },
    take,
    include: { startedBy: { select: { name: true } } },
  })
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    startedByName: r.startedBy.name,
    commitHash: r.commitHash,
    summary: r.summary,
    durationSec: r.finishedAt ? Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000) : null,
  }))
}

export type DeployStatus = {
  mode: DeployMode
  service: ServiceStatus
  currentRun: { id: string; startedAt: string } | null
  lastFinished: { id: string; status: string; finishedAt: string | null; commitHash: string | null } | null
}

export async function getDeployStatus(): Promise<DeployStatus> {
  await reconcileRunningDeploys()
  const { mode } = cfg()
  const [service, current, lastFinished] = await Promise.all([
    getServiceStatus(),
    db.deployRun.findFirst({
      where: { status: 'RUNNING' },
      orderBy: { startedAt: 'desc' },
      select: { id: true, startedAt: true },
    }),
    db.deployRun.findFirst({
      where: { status: { not: 'RUNNING' } },
      orderBy: { startedAt: 'desc' },
      select: { id: true, status: true, finishedAt: true, commitHash: true },
    }),
  ])
  return {
    mode,
    service,
    currentRun: current ? { id: current.id, startedAt: current.startedAt.toISOString() } : null,
    lastFinished: lastFinished
      ? {
          id: lastFinished.id,
          status: lastFinished.status,
          finishedAt: lastFinished.finishedAt?.toISOString() ?? null,
          commitHash: lastFinished.commitHash,
        }
      : null,
  }
}
