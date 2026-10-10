'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { addSuppression, listSuppressions, removeSuppression, reviewSmsOptOut } from '@/lib/telephony/actions'
import type { SuppressionVM } from '@/lib/telephony/voice-contract'
import { actionFailure, thrownMessage, whenLabel } from '@/lib/telephony/ui/result'

/**
 * The account's do-not-call / do-not-text list (plan §2.7, §2.10).
 *
 * Rows hold the last four digits only; the server keeps a keyed hash and
 * never the number. Anyone who can send may add a number. Only managers may
 * remove one, with a note, and only managers settle a "Possible opt-out" (a
 * reply that contained "stop" inside a longer message): texts to that number
 * stay held until they do.
 */

const SOURCE_WORDS: Record<string, string> = {
  sms_stop: 'Texted STOP',
  sms_stop_review: 'Possible opt-out',
  manual: 'Added by hand',
  call_center: 'Marked do not call',
  import: 'Imported',
}

function sourceWord(source: string): string {
  return SOURCE_WORDS[source] ?? source
}

export function DncListCard({ canManage, canAdd }: { canManage: boolean; canAdd: boolean }) {
  const [pending, startTransition] = useTransition()
  const [rows, setRows] = useState<SuppressionVM[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [phone, setPhone] = useState('')
  const [blockSms, setBlockSms] = useState(true)
  const [blockCall, setBlockCall] = useState(true)
  const [reason, setReason] = useState('')
  const [noteFor, setNoteFor] = useState<{ id: string; kind: 'remove' | 'confirm' | 'lift' } | null>(null)
  const [note, setNote] = useState('')

  const reload = useCallback(async () => {
    const res = await listSuppressions()
    const failure = actionFailure(res)
    if (failure) setError(failure.error)
    else if (Array.isArray(res)) setRows(res as SuppressionVM[])
  }, [])

  useEffect(() => {
    let cancelled = false
    listSuppressions()
      .then((res: unknown) => {
        if (cancelled) return
        const failure = actionFailure(res)
        if (failure) setError(failure.error)
        else if (Array.isArray(res)) setRows(res as SuppressionVM[])
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(thrownMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const act = (run: () => Promise<unknown>, after?: () => void) => {
    setError(null)
    startTransition(async () => {
      try {
        const failure = actionFailure(await run())
        if (failure) {
          setError(failure.error)
          return
        }
        after?.()
        await reload()
      } catch (err) {
        setError(thrownMessage(err))
      }
    })
  }

  const finishNote = () => {
    if (!noteFor) return
    const { id, kind } = noteFor
    const text = note.trim()
    act(
      () => (kind === 'remove' ? removeSuppression(id, text) : reviewSmsOptOut(id, kind, text)),
      () => {
        setNoteFor(null)
        setNote('')
      },
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Do not call or text</CardTitle>
        <CardDescription>
          Numbers here are never called or texted, whatever consent says. A STOP reply lands here on its own.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}

        {canAdd && (
          <div className="grid gap-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="h-8 w-44"
                type="tel"
                placeholder="Phone number"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                aria-label="Phone number to block"
              />
              <Input
                className="h-8 min-w-40 flex-1"
                placeholder="Reason"
                value={reason}
                maxLength={120}
                onChange={(e) => setReason(e.target.value)}
                aria-label="Reason"
              />
            </div>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="accent-primary size-4"
                  checked={blockCall}
                  onChange={(e) => setBlockCall(e.target.checked)}
                />
                Block calls
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="accent-primary size-4"
                  checked={blockSms}
                  onChange={(e) => setBlockSms(e.target.checked)}
                />
                Block texts
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={pending || !phone.trim() || !reason.trim() || (!blockCall && !blockSms)}
                onClick={() =>
                  act(
                    () => addSuppression({ phone: phone.trim(), sms: blockSms, call: blockCall, reason: reason.trim() }),
                    () => {
                      setPhone('')
                      setReason('')
                    },
                  )
                }
              >
                {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                Add
              </Button>
            </div>
          </div>
        )}

        {rows === null ? (
          <p className="text-muted-foreground text-sm">{error ? '' : 'Loading…'}</p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nobody on the list.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {rows.map((row) => {
              const review = row.sms?.source === 'sms_stop_review'
              const editing = noteFor?.id === row.id
              return (
                <li key={row.id} className="grid gap-1.5 px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono tabular-nums">•••-•••-{row.last4}</span>
                    {row.call && <Badge variant="secondary">No calls</Badge>}
                    {row.sms && !review && <Badge variant="secondary">No texts</Badge>}
                    {review && <Badge variant="destructive">Possible opt-out</Badge>}
                    <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{row.reason}</span>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {[
                      row.call && `${sourceWord(row.call.source)} ${whenLabel(row.call.at)}`,
                      row.sms && `${sourceWord(row.sms.source)} ${whenLabel(row.sms.at)}`,
                      row.by && `by ${row.by}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {canManage && !editing && (
                    <div className="flex flex-wrap gap-2">
                      {review && (
                        <>
                          <Button size="xs" variant="outline" onClick={() => setNoteFor({ id: row.id, kind: 'confirm' })}>
                            Confirm opt-out
                          </Button>
                          <Button size="xs" variant="outline" onClick={() => setNoteFor({ id: row.id, kind: 'lift' })}>
                            Lift
                          </Button>
                        </>
                      )}
                      <Button size="xs" variant="ghost" onClick={() => setNoteFor({ id: row.id, kind: 'remove' })}>
                        Remove
                      </Button>
                    </div>
                  )}
                  {editing && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        className="h-8 min-w-48 flex-1"
                        placeholder={noteFor.kind === 'lift' ? 'Why it was not an opt-out' : 'Note'}
                        value={note}
                        maxLength={200}
                        onChange={(e) => setNote(e.target.value)}
                        aria-label="Note"
                      />
                      <Button
                        size="sm"
                        disabled={pending || (noteFor.kind !== 'confirm' && note.trim().length < 3)}
                        onClick={finishNote}
                      >
                        {noteFor.kind === 'remove' ? 'Remove' : noteFor.kind === 'lift' ? 'Lift hold' : 'Confirm'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setNoteFor(null)}>
                        Cancel
                      </Button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
