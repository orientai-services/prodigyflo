'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { applyNumberSync, previewNumberSync, setNumberAssignment } from '@/lib/telephony/actions'
import type { SyncPreviewVM, SyncResultVM, SyncRowVM } from '@/lib/telephony/voice-contract'
import { actionFailure, thrownMessage } from '@/lib/telephony/ui/result'

/**
 * Bring the numbers that already live in Twilio into the app (plan §4.4).
 *
 * The server decides who may see what: on the shared account only the
 * platform owner gets rows, and only numbers assigned to an organization can
 * be imported. Rows on another account are shown greyed and are never
 * changed. "Point here" is opt-in per number, and pre-ticked only when the
 * number has no voice URL yet or already points at this app's host.
 */

export type SyncOrgOption = { id: string; name: string }

const IMPORTABLE: SyncRowVM['state'][] = ['new', 'released-here']
const REPOINTABLE: SyncRowVM['state'][] = ['new', 'released-here', 'here']

function stateText(row: SyncRowVM): string {
  if (row.state === 'new') return 'Not here yet'
  if (row.state === 'here') return 'Already here'
  if (row.state === 'released-here') return 'Released here before'
  if (row.state === 'unassigned') return 'Assign to an account first.'
  return `On ${row.otherAccount ?? 'another account'}. Not changed.`
}

function defaultRepoint(row: SyncRowVM): boolean {
  if (row.pointsHere || !REPOINTABLE.includes(row.state)) return false
  if (!row.voiceUrlHost) return true
  return typeof window !== 'undefined' && row.voiceUrlHost === window.location.host
}

export function SyncNumbersDialog({ organizations = [] }: { organizations?: SyncOrgOption[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [preview, setPreview] = useState<SyncPreviewVM | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SyncResultVM | null>(null)
  const [importing, setImporting] = useState<Set<string>>(new Set())
  const [repointing, setRepointing] = useState<Set<string>>(new Set())

  const load = () => {
    setError(null)
    startTransition(async () => {
      try {
        const res = await previewNumberSync()
        const failure = actionFailure(res)
        if (failure) {
          setPreview(null)
          setError(failure.error)
          return
        }
        const next = res as SyncPreviewVM
        setPreview(next)
        setImporting(new Set(next.rows.filter((r) => IMPORTABLE.includes(r.state)).map((r) => r.sid)))
        setRepointing(new Set(next.rows.filter(defaultRepoint).map((r) => r.sid)))
      } catch (err) {
        setError(thrownMessage(err))
      }
    })
  }

  const assign = (sid: string, organizationId: string) => {
    setError(null)
    startTransition(async () => {
      try {
        const failure = actionFailure(await setNumberAssignment({ sid, organizationId: organizationId || null }))
        if (failure) {
          setError(failure.error)
          return
        }
        const res = await previewNumberSync()
        if (!actionFailure(res)) setPreview(res as SyncPreviewVM)
      } catch (err) {
        setError(thrownMessage(err))
      }
    })
  }

  const apply = () => {
    if (!preview) return
    const allowed = new Map(preview.rows.map((r) => [r.sid, r]))
    const importSids = [...importing].filter((sid) => IMPORTABLE.includes(allowed.get(sid)?.state ?? 'unassigned'))
    const repointSids = [...repointing].filter((sid) => REPOINTABLE.includes(allowed.get(sid)?.state ?? 'unassigned'))
    setError(null)
    startTransition(async () => {
      try {
        const res = await applyNumberSync({ importSids, repointSids })
        const failure = actionFailure(res)
        if (failure) {
          setError(failure.error)
          return
        }
        setResult(res as SyncResultVM)
        router.refresh()
      } catch (err) {
        setError(thrownMessage(err))
      }
    })
  }

  const toggle = (set: Set<string>, sid: string, on: boolean, write: (s: Set<string>) => void) => {
    const next = new Set(set)
    if (on) next.add(sid)
    else next.delete(sid)
    write(next)
  }

  const nothingChosen = importing.size === 0 && repointing.size === 0

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setOpen(true)
          setResult(null)
          load()
        }}
      >
        <RefreshCw className="size-3.5" />
        Sync numbers from Twilio
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Sync numbers from Twilio</DialogTitle>
            <DialogDescription>
              {preview
                ? `${preview.platform ? 'Shared account' : 'Your own account'} ${preview.account}. Imported lines start on voicemail and can't be used as caller ID until you set who answers them. No purchase charge.`
                : 'Reading the numbers on the Twilio account…'}
            </DialogDescription>
          </DialogHeader>

          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}

          {result ? (
            <div className="space-y-2 text-sm">
              <p>
                Imported {result.imported}, updated {result.updated}, pointed {result.repointed} here.
              </p>
              {result.skipped.length > 0 && (
                <ul className="text-muted-foreground list-disc space-y-0.5 pl-5 text-xs">
                  {result.skipped.map((s) => (
                    <li key={s.sid}>
                      {preview?.rows.find((r) => r.sid === s.sid)?.display ?? 'A number'}: {s.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : preview && preview.rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">No numbers on this Twilio account.</p>
          ) : preview ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground border-b text-left text-xs">
                    <th className="py-2 pr-3 font-medium">Number</th>
                    <th className="py-2 pr-3 font-medium">State</th>
                    {preview.platform && <th className="py-2 pr-3 font-medium">Account</th>}
                    <th className="py-2 pr-3 font-medium">Import</th>
                    <th className="py-2 pr-3 font-medium">Point here</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => {
                    const greyed = row.state === 'other-account'
                    const canImport = IMPORTABLE.includes(row.state)
                    const canRepoint = REPOINTABLE.includes(row.state) && !row.pointsHere
                    return (
                      <tr key={row.sid} className={['border-b align-top', greyed ? 'opacity-55' : ''].join(' ')}>
                        <td className="py-2 pr-3">
                          <p className="font-mono tabular-nums">{row.display}</p>
                          <p className="text-muted-foreground text-xs">
                            {[
                              row.friendlyName,
                              row.capabilities.voice && 'voice',
                              row.capabilities.sms && 'sms',
                              row.capabilities.mms && 'mms',
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </p>
                        </td>
                        <td className="py-2 pr-3 text-xs">
                          {stateText(row)}
                          {row.voiceUrlHost && !row.pointsHere && (
                            <p className="text-muted-foreground">Points elsewhere: {row.voiceUrlHost}</p>
                          )}
                          {row.pointsHere && <p className="text-muted-foreground">Points here</p>}
                        </td>
                        {preview.platform && (
                          <td className="py-2 pr-3">
                            {greyed ? (
                              <span className="text-muted-foreground text-xs">{row.otherAccount ?? 'another account'}</span>
                            ) : (
                              <select
                                className="border-input bg-background h-7 max-w-44 rounded-md border px-1.5 text-xs"
                                value={row.assignedOrg?.id ?? ''}
                                disabled={pending}
                                aria-label={`Account for ${row.display}`}
                                onChange={(e) => assign(row.sid, e.target.value)}
                              >
                                <option value="">Not assigned</option>
                                {row.assignedOrg && !organizations.some((o) => o.id === row.assignedOrg?.id) && (
                                  <option value={row.assignedOrg.id}>{row.assignedOrg.name}</option>
                                )}
                                {organizations.map((o) => (
                                  <option key={o.id} value={o.id}>
                                    {o.name}
                                  </option>
                                ))}
                              </select>
                            )}
                          </td>
                        )}
                        <td className="py-2 pr-3">
                          <input
                            type="checkbox"
                            className="accent-primary size-4"
                            disabled={!canImport || pending}
                            checked={canImport && importing.has(row.sid)}
                            onChange={(e) => toggle(importing, row.sid, e.target.checked, setImporting)}
                            aria-label={`Import ${row.display}`}
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <input
                            type="checkbox"
                            className="accent-primary size-4"
                            disabled={!canRepoint || pending}
                            checked={canRepoint && repointing.has(row.sid)}
                            onChange={(e) => toggle(repointing, row.sid, e.target.checked, setRepointing)}
                            aria-label={`Point ${row.display} at this app`}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : pending ? (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 className="size-3.5 animate-spin" /> Checking Twilio…
            </p>
          ) : null}

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              {result ? 'Done' : 'Cancel'}
            </Button>
            {!result && preview && preview.rows.length > 0 && (
              <Button size="sm" onClick={apply} disabled={pending || nothingChosen}>
                {pending && <Loader2 className="size-3.5 animate-spin" />}
                Apply
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
