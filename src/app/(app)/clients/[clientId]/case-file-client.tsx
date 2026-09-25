'use client'

import { useState, type ReactNode } from 'react'
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
import { Textarea } from '@/components/ui/textarea'
import { cellDisplay } from '@/lib/daily-desk-finance'
import type { CaseDocTile, CaseFileData } from '@/lib/daily-desk-case-types'
import { bookAppointmentAction } from '@/app/(app)/board/actions'
import { UploadButton } from '@/app/(app)/documents/upload-button'
import { PdfPreview } from '@/components/client/pdf-preview'
import { requestDocuments } from '@/app/(app)/documents/actions'
import { applyCloserAction } from './assignment-actions'
import { approveBriefAction, editBriefAction } from './closeops-actions'

export function CaseFileView({ data, children, cys }: { data: CaseFileData; children?: ReactNode; cys?: ReactNode }) {
  const router = useRouter()
  const [assignOpen, setAssignOpen] = useState(false)
  const [bookOpen, setBookOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [look, setLook] = useState<CaseDocTile | null>(null)
  const [closerId, setCloserId] = useState(data.closers[0]?.id ?? '')
  const [bookDate, setBookDate] = useState(data.bookDate)
  const [bookTime, setBookTime] = useState(data.bookTime)
  const [briefBody, setBriefBody] = useState(data.brief?.body ?? '')
  const [pending, setPending] = useState(false)

  const loc = [data.city, data.state, data.zip].filter(Boolean).join(', ')
  const docTotal = data.docs.length

  async function runAssign() {
    if (!closerId) return
    setPending(true)
    const result = await applyCloserAction({ clientId: data.id, assigneeId: closerId })
    setPending(false)
    if (result.ok) {
      toast.success('Closer assigned.')
      setAssignOpen(false)
      router.refresh()
    } else toast.error(result.error ?? 'Could not assign.')
  }

  async function runBook() {
    setPending(true)
    const result = await bookAppointmentAction({
      clientId: data.id,
      appointmentId: data.appointmentId ?? undefined,
      expectedUpdatedAt: data.appointmentUpdatedAt ?? undefined,
      requestId: crypto.randomUUID(),
      date: bookDate,
      time: bookTime || '10:00',
      timezone: data.timezone,
    })
    setPending(false)
    if (result.ok) {
      toast.success('Appointment saved.')
      setBookOpen(false)
      router.refresh()
    } else toast.error(result.error ?? 'Could not book.')
  }

  async function requestKinds(requirementIds: string[]) {
    if (requirementIds.length === 0) {
      toast.error('No collection row for those documents yet. Empty tile stays empty.')
      return
    }
    setPending(true)
    const result = await requestDocuments({ clientId: data.id, requirementIds })
    setPending(false)
    if (result.ok) {
      toast.success(result.message ?? 'Documents requested.')
      router.refresh()
    } else toast.error(result.error ?? 'Could not request documents.')
  }

  async function runApprove() {
    if (!data.brief) return
    setPending(true)
    const result = await approveBriefAction({ clientId: data.id, briefId: data.brief.id })
    setPending(false)
    if (result.ok) {
      toast.success('Brief approved. CYS was not submitted.')
      router.refresh()
    } else toast.error(result.error ?? 'Could not approve.')
  }

  async function runEdit() {
    if (!data.brief) return
    setPending(true)
    const result = await editBriefAction({ clientId: data.id, briefId: data.brief.id, body: briefBody })
    setPending(false)
    if (result.ok) {
      toast.success('Brief updated.')
      setEditOpen(false)
      router.refresh()
    } else toast.error(result.error ?? 'Could not edit.')
  }

  const missingReqIds = data.docs.filter((d) => d.state === 'missing' && d.requirementId).map((d) => d.requirementId!)

  return (
    <div className="desk-page">
      <article className="desk-card desk-ph">
        <div>
          <Link href="/board" className="desk-btn-secondary">
            ← Board
          </Link>
          <div className="desk-who">
            {data.firstName} {data.lastName}
          </div>
          <div className="desk-muted" style={{ marginBottom: 0 }}>
            {loc || 'Address not on file'} · {data.source} · {data.stage}
          </div>
          <div className="desk-tags">
            <span className={`desk-tag ${data.ownerName ? 'ok' : 'warn'}`}>
              Owner: {data.ownerName ?? 'Unassigned'}
            </span>
            <span className="desk-tag">{data.appointmentLabel ? `Appt ${data.appointmentLabel}` : 'Not booked'}</span>
            <span className="desk-tag">
              Docs {data.docsPresent}/{docTotal}
            </span>
            <span className={`desk-tag ${data.extractionLabel === 'verified' ? 'ok' : 'warn'}`}>
              Extraction {data.extractionLabel}
            </span>
            <span className={`desk-tag ${data.creditOnFile ? 'ok' : 'warn'}`}>{data.creditLabel}</span>
            <span className={`desk-tag ${data.packetReady ? 'ok' : 'warn'}`}>
              {data.packetReady ? 'Packet READY' : 'Packet not ready'}
            </span>
            <span
              className={`desk-tag ${data.cysApproved ? 'ok' : 'warn'}`}
              title={
                data.cysApproved
                  ? 'Human CYS approvedAt is set'
                  : data.cysBlockers.length
                    ? data.cysBlockers.join(' ')
                    : 'Fields verified; waiting on human approvedAt'
              }
            >
              {data.cysApproved ? 'CYS ready' : 'CYS not ready'}
            </span>
          </div>
        </div>
        <div className="desk-actions-row">
          {data.canAssign && (
            <button type="button" className="btn-desk" onClick={() => setAssignOpen(true)}>
              Assign closer
            </button>
          )}
          {data.canBook && (
            <button type="button" className="desk-btn-secondary" onClick={() => setBookOpen(true)}>
              {data.appointmentLabel ? 'Reschedule' : 'Book'}
            </button>
          )}
          {data.canRequest && (
            <button
              type="button"
              className="desk-btn-secondary"
              disabled={pending}
              onClick={() => void requestKinds(missingReqIds)}
            >
              Request missing docs
            </button>
          )}
        </div>
      </article>

      <div className="desk-g2">
        <section className="desk-card desk-block">
          <h3>Finance agreement</h3>
          <div className="desk-math">
            {data.finance.map((row) => (
              <div key={row.label} className="desk-cell">
                <label>{row.label}</label>
                <div className={`desk-v ${row.cell.kind !== 'value' ? 'miss' : ''}`}>{cellDisplay(row.cell)}</div>
                {row.unverified && <small>Extracted · needs review</small>}
                {row.hint && <small>{row.hint}</small>}
                {row.cell.kind === 'cannot_compute' && !row.hint && (
                  <small>Needs {row.cell.missing.join(', ')}</small>
                )}
              </div>
            ))}
          </div>
        </section>
        <section className="desk-card desk-block">
          <h3>Solar / intake</h3>
          <div className="desk-math">
            {data.solar.map((row) => (
              <div key={row.label} className="desk-cell">
                <label>{row.label}</label>
                <div className={`desk-v ${row.cell.kind !== 'value' ? 'miss' : ''}`} style={{ fontSize: 16 }}>
                  {row.label === 'Credit score' && row.cell.kind !== 'value' ? 'Not on file' : cellDisplay(row.cell)}
                </div>
                {row.unverified && <small>Extracted · needs review</small>}
                {row.hint && <small>{row.hint}</small>}
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="desk-card desk-block">
        <h3>Documents</h3>
        <p className="desk-muted">Open existing files or add paperwork received outside the intake form. Earlier files and versions remain available.</p>
        <div className="desk-docs">
          {data.docs.map((doc) => (
            <div key={doc.key} id={`document-${doc.key}`} className="desk-doc">
              <button type="button" className="desk-doc-top w-full text-left" onClick={() => setLook(doc.documentId || !doc.files[0] ? doc : { ...doc, documentId: doc.files[0].id, fileUrl: doc.files[0].fileUrl, mimeType: doc.files[0].mimeType, extract: null })}>
                <span>{doc.label}</span><span className="desk-look">Quick view</span>
              </button>
              <div className={`desk-st ${doc.state === 'missing' || doc.state === 'failed' ? 'miss' : 'ok'}`}>
                {doc.state.replace('_', ' ')}{doc.files.length > 0 && ` · ${doc.files.length} file${doc.files.length === 1 ? '' : 's'}`}
              </div>
              {data.canUpload && <UploadButton clientId={data.id} requirementId={doc.requirementId ?? undefined} label={doc.label} buttonLabel={doc.files.length ? 'Add document' : 'Upload document'} />}
            </div>
          ))}
        </div>
      </section>

      {cys}

      <div className="desk-g2">
        <section className="desk-card desk-block">
          <h3>Original intake answers · verbatim</h3>
          {data.intake.length === 0 ? (
            <p className="desk-muted">No intake answers stored.</p>
          ) : (
            <div className="desk-qa">
              {data.intake.map((row) => (
                <div key={row.question}>
                  <b>{row.question}</b>
                  {row.answer}
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="desk-card desk-block desk-prose">
          <h3>Redline · internal posture</h3>
          <p className="desk-muted">State and federal consumer rights for this file. Not a homeowner lecture.</p>
          <p>
            <b>{data.state || 'State'} consumer rights</b>
          </p>
          {data.redline.state.length === 0 ? (
            <p className="desk-muted">No state rights until the property state is on the file.</p>
          ) : (
            <ul>
              {data.redline.state.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
          <p>
            <b>Federal consumer rights</b>
          </p>
          {data.redline.federal.length === 0 ? (
            <p className="desk-muted">No federal rights on this file yet.</p>
          ) : (
            <ul>
              {data.redline.federal.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="desk-card desk-block desk-prose">
        <h3>Closer brief {data.brief?.approved ? '· approved' : ''}</h3>
        <p>
          {data.firstName} {data.lastName}
          {[data.city, data.state].filter(Boolean).length ? ` · ${[data.city, data.state].filter(Boolean).join(', ')}` : ''}.{' '}
          {data.ownerName ? `Closer: ${data.ownerName}.` : 'No closer assigned.'} Case review is what you show the client. Closer pitch is how you run the call.
        </p>
        <div className="desk-actions-row" style={{ marginTop: 10 }}>
          <a className="btn-desk" href={`/api/clients/${data.id}/closer-packet?kind=review`}>Case review PDF</a>
          <a className="desk-btn-secondary" href={`/api/clients/${data.id}/closer-packet?kind=pitch`}>Closer pitch PDF</a>
          {data.brief && (
            <>
              <button type="button" className="btn-desk" disabled={pending || data.brief.approved} onClick={() => void runApprove()}>
                {data.brief.approved ? 'Approved' : 'Approve brief'}
              </button>
              <button
                type="button"
                className="desk-btn-secondary"
                onClick={() => {
                  setBriefBody(data.brief?.body ?? '')
                  setEditOpen(true)
                }}
              >
                Edit
              </button>
            </>
          )}
        </div>
        {children}
      </section>

      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent className="desk desk-dialog sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Assign closer</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Label htmlFor="case-closer">Closer</Label>
            <NativeSelect id="case-closer" className="w-full" value={closerId} onChange={(e) => setCloserId(e.target.value)}>
              {data.closers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignOpen(false)}>
              Cancel
            </Button>
            <Button disabled={pending || !closerId} onClick={() => void runAssign()}>
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bookOpen} onOpenChange={setBookOpen}>
        <DialogContent className="desk desk-dialog sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Book / reschedule</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Label htmlFor="case-date">Date</Label>
            <Input id="case-date" type="date" value={bookDate} onChange={(e) => setBookDate(e.target.value)} />
            <Label htmlFor="case-time">Time</Label>
            <Input id="case-time" type="time" value={bookTime} onChange={(e) => setBookTime(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBookOpen(false)}>
              Cancel
            </Button>
            <Button disabled={pending} onClick={() => void runBook()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="desk desk-dialog sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit brief</DialogTitle>
          </DialogHeader>
          <Textarea rows={8} value={briefBody} onChange={(e) => setBriefBody(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button disabled={pending} onClick={() => void runEdit()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={look !== null} onOpenChange={(open) => !open && setLook(null)}>
        <DialogContent
          className="desk desk-lookbox max-w-[96vw] sm:max-w-[96vw] w-[96vw] h-[92vh] p-4"
          showCloseButton={false}
          style={{ maxWidth: '96vw', width: '96vw', height: '92vh', maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        >
          {look && (
            <>
              <div className="desk-lookhead">
                <div>
                  <div className="desk-muted" style={{ fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                    Quick look
                  </div>
                  <DialogTitle>{look.label}</DialogTitle>
                  <div className="desk-muted">
                    {data.firstName} {data.lastName} · {look.state.replace('_', ' ')}
                  </div>
                </div>
                <button type="button" className="desk-btn-secondary" onClick={() => setLook(null)}>
                  Close
                </button>
              </div>
              {look.files.length > 0 && (
                <NativeSelect aria-label="Choose document file" value={look.documentId ?? look.files[0]?.id} onChange={(event) => {
                  const file = look.files.find((entry) => entry.id === event.target.value)
                  const originalTile = data.docs.find((tile) => tile.key === look.key)
                  if (file) setLook({ ...look, documentId: file.id, fileUrl: file.fileUrl, mimeType: file.mimeType, extract: file.id === originalTile?.documentId ? originalTile.extract : null })
                }}>
                  {look.files.map((file) => <option key={file.id} value={file.id}>{file.label} · v{file.version} · {file.status.toLowerCase().replaceAll('_', ' ')}</option>)}
                </NativeSelect>
              )}
              {data.canUpload && <UploadButton clientId={data.id} requirementId={look.requirementId ?? undefined} label={look.label} buttonLabel="Add document" />}
              {look.fileUrl && <div className="flex flex-wrap gap-4">
                <a className="underline" href={look.fileUrl} target="_blank" rel="noopener noreferrer">Open original</a>
                <a className="underline" href={`${look.fileUrl}${look.fileUrl.includes('?') ? '&' : '?'}download=1`}>Download</a>
              </div>}
              {look.fileUrl ? (
                <div className="grid min-h-0 flex-1 gap-4 overflow-auto lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]">
                  <div className="desk-paper" style={{ margin: 0 }}>
                    {look.extract ? <>
                      <div className="desk-muted">{look.extract.kicker}</div>
                      <h4 className="mb-3 text-lg">{look.extract.title}</h4>
                      <p className="desk-muted mb-4">{look.extract.note}</p>
                      <div className="desk-kv" style={{ gridTemplateColumns: '1fr' }}>
                        {look.extract.fields.map((f) => <div key={f.label}><b>{f.label}</b>{f.value}</div>)}
                      </div>
                    </> : <p className="desk-muted">No extraction result is available for this document version. The original file is available for review.</p>}
                  </div>
                  <div className="desk-paper" style={{ margin: 0, minWidth: 0 }}>
                  {look.mimeType?.startsWith('image/') ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={look.fileUrl} alt={look.label} style={{ width: '100%', height: 'auto', maxHeight: 'calc(92vh - 110px)', objectFit: 'contain' }} />
                  ) : look.mimeType === 'application/pdf' ? (
                    <PdfPreview key={look.fileUrl} url={look.fileUrl} title={look.label} />
                  ) : (
                    <iframe title={look.label} src={look.fileUrl} style={{ width: '100%', height: '60vh', border: 0 }} />
                  )}
                  </div>
                </div>
              ) : look.extract ? (
                <div className="desk-paper">
                  <div className="desk-muted" style={{ letterSpacing: '0.14em', textTransform: 'uppercase', fontSize: 11 }}>
                    {look.extract.kicker}
                  </div>
                  <h4 className="font-heading" style={{ fontSize: 22, fontWeight: 500, margin: '8px 0 14px' }}>
                    {look.extract.title}
                  </h4>
                  <div className="desk-kv">
                    {look.extract.fields.map((f) => (
                      <div key={f.label}>
                        <b>{f.label}</b>
                        {f.value}
                      </div>
                    ))}
                  </div>
                  <p className="desk-muted" style={{ marginTop: 16 }}>
                    {look.extract.note}
                  </p>
                </div>
              ) : (
                <div className="desk-empty-look">
                  <div className="desk-v miss" style={{ fontSize: 20 }}>
                    Not on file
                  </div>
                  <p className="desk-muted">This document is not uploaded yet. No preview is invented.</p>
                  {data.canRequest && look.requirementId && (
                    <button
                      type="button"
                      className="btn-desk"
                      disabled={pending}
                      onClick={() => void requestKinds([look.requirementId!])}
                    >
                      Request {look.label}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
