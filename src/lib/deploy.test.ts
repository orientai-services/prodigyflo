import { describe, expect, it } from 'vitest'
import {
  buildDeployArgv,
  clampLogWindow,
  DEPLOY_MIN_RUNTIME_MS,
  DEPLOY_STALL_MS,
  DEPLOY_TIMEOUT_MS,
  detectDeployOutcome,
  isLockStale,
  listOpsCommands,
  LOCK_STALE_MS,
  LOG_WINDOW_BYTES,
  opsCommand,
} from '@/lib/deploy'

// Pure tests only — nothing here touches the database, the filesystem, or a
// child process. The registry and the slicing/outcome math are the security-
// and correctness-critical parts, so they get exercised directly.

describe('ops command allowlist', () => {
  it('exposes exactly the five read-only commands', () => {
    expect(listOpsCommands().map((c) => c.key).sort()).toEqual(
      ['disk', 'journal', 'memory', 'migrate-status', 'status'].sort(),
    )
  })

  it('resolves each key to an exact argv array with no shell involved', () => {
    expect(opsCommand('status')?.argv).toEqual(['systemctl', 'is-active', 'prodigyflo'])
    expect(opsCommand('disk')?.argv).toEqual(['df', '-h'])
    expect(opsCommand('memory')?.argv).toEqual(['free', '-m'])
    expect(opsCommand('journal')?.argv).toEqual([
      'journalctl', '-u', 'prodigyflo', '-n', '80', '--no-pager', '--output', 'short-iso',
    ])
    expect(opsCommand('migrate-status')?.argv).toEqual(['npx', 'prisma', 'migrate', 'status'])
    // No entry ever contains shell metacharacters that would hint at string
    // execution, and none of the forbidden operations are registered.
    for (const { key } of listOpsCommands()) {
      const spec = opsCommand(key)!
      for (const part of spec.argv) {
        expect(part).not.toMatch(/[;&|<>$`]/)
      }
      expect(spec.argv.join(' ')).not.toMatch(/seed|vitest|reports|nginx/)
    }
  })

  it('rejects anything outside the allowlist — keys are exact, never interpolated', () => {
    expect(opsCommand('reboot')).toBeNull()
    expect(opsCommand('status; rm -rf /')).toBeNull()
    expect(opsCommand('Status')).toBeNull()
    expect(opsCommand(' status')).toBeNull()
    expect(opsCommand('')).toBeNull()
    expect(opsCommand('journal -n 9999')).toBeNull()
  })

  it('registry entries are frozen — a caller cannot mutate the argv', () => {
    const spec = opsCommand('status')!
    expect(Object.isFrozen(spec)).toBe(true)
    expect(Object.isFrozen(spec.argv)).toBe(true)
    expect(() => {
      ;(spec.argv as unknown as string[]).push('--evil')
    }).toThrow()
  })
})

describe('clampLogWindow', () => {
  it('slices from the offset up to the window cap', () => {
    expect(clampLogWindow(100, 0)).toEqual({ start: 0, length: 100, nextOffset: 100, eof: true })
    expect(clampLogWindow(100, 40)).toEqual({ start: 40, length: 60, nextOffset: 100, eof: true })
  })

  it('caps a large remainder at maxBytes and reports more to come', () => {
    const win = clampLogWindow(LOG_WINDOW_BYTES * 3, 10, LOG_WINDOW_BYTES)
    expect(win).toEqual({
      start: 10,
      length: LOG_WINDOW_BYTES,
      nextOffset: 10 + LOG_WINDOW_BYTES,
      eof: false,
    })
  })

  it('degrades hostile offsets safely', () => {
    expect(clampLogWindow(50, -10)).toEqual({ start: 0, length: 50, nextOffset: 50, eof: true })
    expect(clampLogWindow(50, 999)).toEqual({ start: 50, length: 0, nextOffset: 50, eof: true })
    expect(clampLogWindow(50, Number.NaN)).toEqual({ start: 0, length: 50, nextOffset: 50, eof: true })
    // Non-finite offsets are treated like 0 — a harmless re-read from the top.
    expect(clampLogWindow(50, Number.POSITIVE_INFINITY)).toEqual({
      start: 0, length: 50, nextOffset: 50, eof: true,
    })
    expect(clampLogWindow(0, 0)).toEqual({ start: 0, length: 0, nextOffset: 0, eof: true })
    expect(clampLogWindow(-5, 0)).toEqual({ start: 0, length: 0, nextOffset: 0, eof: true })
  })

  it('offsets are stable across polls: consecutive windows tile the file', () => {
    const size = 150
    const first = clampLogWindow(size, 0, 64)
    const second = clampLogWindow(size, first.nextOffset, 64)
    const third = clampLogWindow(size, second.nextOffset, 64)
    expect(first.length + second.length + third.length).toBe(size)
    expect(third.eof).toBe(true)
  })
})

describe('detectDeployOutcome', () => {
  const base = { startedAtMs: 0, lastLogWriteMs: 1000, nowMs: 60_000 }

  it('DEPLOY_OK on its own line means success', () => {
    expect(detectDeployOutcome({ ...base, logText: 'building…\nDEPLOY_OK\n' })).toBe('SUCCEEDED')
    expect(detectDeployOutcome({ ...base, logText: 'DEPLOY_OK' })).toBe('SUCCEEDED')
  })

  it('DEPLOY_OK embedded mid-line does not count', () => {
    expect(detectDeployOutcome({ ...base, logText: 'echo DEPLOY_OK when done\n' })).toBeNull()
  })

  it('a young, chatty deploy is still running', () => {
    expect(
      detectDeployOutcome({ logText: 'npm ci…', startedAtMs: 0, lastLogWriteMs: 50_000, nowMs: 60_000 }),
    ).toBeNull()
  })

  it('a log gone quiet past the stall window fails — silence is the failure signal', () => {
    const startedAtMs = 0
    const nowMs = DEPLOY_MIN_RUNTIME_MS + DEPLOY_STALL_MS + 5_000
    expect(
      detectDeployOutcome({ logText: 'npm ci…', startedAtMs, lastLogWriteMs: 1_000, nowMs }),
    ).toBe('FAILED')
    // …but not before the minimum runtime has passed.
    expect(
      detectDeployOutcome({
        logText: 'npm ci…',
        startedAtMs: 0,
        lastLogWriteMs: 1_000,
        nowMs: DEPLOY_MIN_RUNTIME_MS - 1_000,
      }),
    ).toBeNull()
  })

  it('the absolute timeout fails a run even when mtime is unknown', () => {
    expect(
      detectDeployOutcome({
        logText: '',
        startedAtMs: 0,
        lastLogWriteMs: null,
        nowMs: DEPLOY_TIMEOUT_MS + 1,
      }),
    ).toBe('FAILED')
    expect(
      detectDeployOutcome({ logText: '', startedAtMs: 0, lastLogWriteMs: null, nowMs: DEPLOY_TIMEOUT_MS - 1 }),
    ).toBeNull()
  })
})

describe('lock + launch helpers', () => {
  it('isLockStale honors the staleness window', () => {
    expect(isLockStale(0, LOCK_STALE_MS - 1)).toBe(false)
    expect(isLockStale(0, LOCK_STALE_MS + 1)).toBe(true)
  })

  it('buildDeployArgv prefers a transient systemd unit that appends to the log', () => {
    const argv = buildDeployArgv('/opt/prodigyflo/deploy.sh', '/opt/prodigyflo/deploy.log', {
      systemdRun: true,
    })
    expect(argv[0]).toBe('systemd-run')
    expect(argv).toContain('--property=StandardOutput=append:/opt/prodigyflo/deploy.log')
    expect(argv.slice(-2)).toEqual(['/bin/bash', '/opt/prodigyflo/deploy.sh'])
  })

  it('buildDeployArgv falls back to plain detached bash', () => {
    expect(
      buildDeployArgv('/opt/prodigyflo/deploy.sh', '/opt/prodigyflo/deploy.log', { systemdRun: false }),
    ).toEqual(['/bin/bash', '/opt/prodigyflo/deploy.sh'])
  })
})
