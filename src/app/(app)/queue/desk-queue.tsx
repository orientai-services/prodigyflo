'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { applyCloserAction } from '@/app/(app)/clients/[clientId]/assignment-actions'
import { bookAppointmentAction } from '@/app/(app)/board/actions'
import { requestDocuments } from '@/app/(app)/documents/actions'
import type { DeskQueue, DeskQueueRow } from '@/lib/daily-desk-queue-data'

export function DeskQueueView({ queue }: { queue: DeskQueue }) {
  const router = useRouter()
  const [assignRow, setAssignRow] = useState<DeskQueueRow | null>(null)
  const [bookRow, setBookRow] = useState<DeskQueueRow | null>(null)
  const [closerId, setCloserId] = useState(queue.closers[0]?.id ?? '')
  const [bookDate, setBookDate] = useState(new Date().toISOString().slice(0, 10))
  const [bookTime, setBookTime] = useState('10:00')
  const [pending, setPending] = useState(false)

  async function runAssign() {
    if (!assignRow || !closerId) return
    setPending(true)
    const result = await applyCloserAction({ clientId: assignRow.clientId, assigneeId: closerId })
    setPending(false)
    if (result.ok) {
      toast.success('Closer assigned.')
      setAssignRow(null)
      router.refresh()
    } else toast.error(result.error ?? 'Could not assign.')
  }

  async function runBook() {
    if (!bookRow) return
    setPending(true)
    const result = await bookAppointmentAction({
      clientId: bookRow.clientId,
      requestId: crypto.randomUUID(),
      date: bookDate,
      time: bookTime || '10:00',
      timezone: 'America/Los_Angeles',
    })
    setPending(false)
    if (result.ok) {
      toast.success('Appointment saved.')
      setBookRow(null)
      router.refresh()
    } else toast.error(result.error ?? 'Could not book.')
  }

  async function runRequest(row: DeskQueueRow) {
    if (row.missingRequirementIds.length === 0) {
      toast.error('No collection row for those documents yet.')
      return
    }
    setPending(true)
    const result = await requestDocuments({ clientId: row.clientId, requirementIds: row.missingRequirementIds })
    setPending(false)
    if (result.ok) {
      toast.success(result.message ?? 'Documents requested.')
      router.refresh()
    } else toast.error(result.error ?? 'Could not request documents.')
  }

  return (
    <div className="desk-page">
      <div className="desk-cal-head" style={{ padding: '0 0 16px' }}>
        <div>
          <h1 className="font-heading" style={{ fontSize: 32, fontWeight: 500 }}>
            Queue
          </h1>
          <p className="desk-muted">Human work only. Each row opens the case file. Packet READY and CYS stay separate gates.</p>
        </div>
      </div>

      {queue.buckets.map((bucket) => (
        <section key={bucket.key} className="desk-card desk-block" data-queue-bucket={bucket.key}>
          <div className="desk-cal-head" style={{ padding: 0 }}>
            <h2 className="font-heading" style={{ fontSize: 24 }}>
              {bucket.title}
            </h2>
            <span className="desk-muted">
              {bucket.rows.length === bucket.total
                ? `${bucket.total}`
                : `${bucket.rows.length} of ${bucket.total}`}
            </span>
          </div>
          <p className="desk-muted">{bucket.description}</p>
          {bucket.rows.length === 0 ? (
            <p className="desk-muted">Nothing in this bucket.</p>
          ) : (
            <table className="desk-table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Why</th>
                  <th>Owner</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {bucket.rows.map((row) => (
                  <tr key={`${bucket.key}-${row.clientId}`}>
                    <td>
                      <Link href={`/clients/${row.clientId}`} className="font-medium">
                        {row.name}
                      </Link>
                    </td>
                    <td>{row.why}</td>
                    <td>{row.ownerName ?? 'Unassigned'}</td>
                    <td>
                      <div className="desk-actions-row" style={{ justifyContent: 'flex-end' }}>
                        {bucket.key === 'unassigned' && queue.canAssign && (
                          <button type="button" className="desk-btn-secondary" onClick={() => setAssignRow(row)}>
                            Assign
                          </button>
                        )}
                        {bucket.key === 'unscheduled' && queue.canBook && (
                          <button type="button" className="desk-btn-secondary" onClick={() => setBookRow(row)}>
                            Book
                          </button>
                        )}
                        {bucket.key === 'missing_docs' && queue.canRequest && (
                          <button
                            type="button"
                            className="desk-btn-secondary"
                            disabled={pending}
                            onClick={() => void runRequest(row)}
                          >
                            Request
                          </button>
                        )}
                        <Link href={`/clients/${row.clientId}`} className="desk-btn-secondary">
                          Open
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}

      <Dialog open={assignRow !== null} onOpenChange={(open) => !open && setAssignRow(null)}>
        <DialogContent className="desk desk-dialog sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Assign closer</DialogTitle>
          </DialogHeader>
          <p className="desk-muted">{assignRow?.name}</p>
          <Label htmlFor="q-closer">Closer</Label>
          <NativeSelect id="q-closer" className="w-full" value={closerId} onChange={(e) => setCloserId(e.target.value)}>
            {queue.closers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignRow(null)}>
              Cancel
            </Button>
            <Button disabled={pending || !closerId} onClick={() => void runAssign()}>
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bookRow !== null} onOpenChange={(open) => !open && setBookRow(null)}>
        <DialogContent className="desk desk-dialog sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Book appointment</DialogTitle>
          </DialogHeader>
          <p className="desk-muted">{bookRow?.name}</p>
          <Label htmlFor="q-date">Date</Label>
          <Input id="q-date" type="date" value={bookDate} onChange={(e) => setBookDate(e.target.value)} />
          <Label htmlFor="q-time">Time</Label>
          <Input id="q-time" type="time" value={bookTime} onChange={(e) => setBookTime(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setBookRow(null)}>
              Cancel
            </Button>
            <Button disabled={pending} onClick={() => void runBook()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
