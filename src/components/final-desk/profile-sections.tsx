'use client'

import type { ReactNode } from 'react'
import { useUiLocale } from '@/components/locale-switch'
import { UI_COPY } from '@/lib/ui-copy'
import { uiCopyFor } from '@/lib/ui-copy.es'
import type { CaseCell, CaseDocTile, CaseFileData } from '@/lib/daily-desk-case-types'
import { DocumentTileActions } from './document-tile-actions'

/**
 * The client profile's sections, shared by /clients/[id] (FinalDesk) and the
 * dialer's lead panel (call-center/lead-profile). Markup is the profile's own:
 * a change here shows on both screens.
 */

export function Cell({ value }: { value: CaseCell }) {
  const t = uiCopyFor(useUiLocale(), UI_COPY)
  const c = value.cell
  return <div className="cell"><label>{value.label}</label><div className={`v${c.kind === 'value' ? '' : ' m'}`}>
    {c.kind === 'value' ? c.display : c.kind === 'cannot_compute' ? t.cannotCompute : t.missing}
  </div>{(value.hint || value.unverified || c.kind === 'cannot_compute') && <small>{[value.unverified ? t.unverified : '', value.hint, c.kind === 'cannot_compute' ? `Needs ${c.missing.join(', ')}` : ''].filter(Boolean).join(' · ')}</small>}</div>
}

export function LeadSourceSection({ rows }: { rows: { label: string; value: string }[] }) {
  return <div className="card block" style={{ marginBottom: 14 }} data-testid="lead-attribution"><h3>Lead source · Meta</h3><div className="qa">{rows.map(r => <div key={r.label}><b>{r.label}</b>{r.value}</div>)}</div></div>
}

export function FinanceSection({ cells }: { cells: CaseCell[] }) {
  return <div className="card block"><h3>Finance agreement</h3><div className="math">{cells.map(c => <Cell key={c.label} value={c} />)}</div></div>
}

export function SolarSection({ cells }: { cells: CaseCell[] }) {
  return <div className="card block"><h3>Solar / intake</h3><div className="math">{cells.map(c => <Cell key={c.label} value={c} />)}</div></div>
}

/** Quick look, Upload and Download per tile. `canUpload` false greys Upload out. */
export function DocumentsSection({ docs, canUpload, busy, onLook, onUpload }: {
  docs: CaseDocTile[]
  canUpload: boolean
  busy: boolean
  onLook: (tile: CaseDocTile) => void
  onUpload: (tile: CaseDocTile) => void
}) {
  const t = uiCopyFor(useUiLocale(), UI_COPY)
  return <div className="card block" style={{ marginBottom: 14 }}><h3>Documents</h3><p className="muted" style={{ margin: '-4px 0 12px' }}>Click Quick look to open the page. Live desk will load the real file; this prototype shows the extract when a document exists.</p><div className="docs">{docs.map(d => <div key={d.key} className="doc"><div className="doc-top"><span>{(t.tiles as Record<string, string>)[d.key] ?? d.label}</span><DocumentTileActions tile={d} busy={busy} canUpload={canUpload} onLook={() => onLook(d)} onUpload={() => onUpload(d)} /></div><div className={`st ${d.state === 'missing' || d.state === 'failed' ? 'm' : 'g'}`}>{d.state}</div>{d.records && <small className="muted" data-testid="records-status">{d.records}</small>}</div>)}</div></div>
}

/** The verbatim SCS intake answers. `children` sits under the answers (the questionnaire tab). */
export function IntakeSection({ intake, children }: { intake: CaseFileData['intake']; children?: ReactNode }) {
  return <div className="card block"><h3>Intake answers · verbatim</h3><div className="qa">{intake.map((a, i) => <div key={i}><b>{a.question}</b>{a.answer}</div>)}</div>{children}</div>
}

/**
 * Progress on the 42-question Final Questionnaire. With `onOpen` it is the
 * desk's button; with `href` a link (the dialer opens it in a new tab); with
 * neither it only reports progress (a read-only view).
 */
export function QuestionnaireProgress({ done, progress, onOpen, href }: { done: boolean; progress: number; onOpen?: () => void; href?: string }) {
  const body = <><div><b>Client&apos;s Questionnaire Form</b><div className="muted">{done ? 'All 42 answered' : `${progress} of 42 answered · finish on the booking call`}</div></div><div className={`mark tag ${done ? 'g' : 'w'}`}>{done ? '✓ Completed' : 'In progress'}</div></>
  if (onOpen) return <button className="qtab" style={{ margin: '14px 0 0' }} onClick={onOpen}>{body}</button>
  if (href) return <a className="qtab" style={{ margin: '14px 0 0' }} href={href} target="_blank" rel="noopener noreferrer">{body}</a>
  return <div className="qtab" style={{ margin: '14px 0 0', cursor: 'default' }}>{body}</div>
}

export function RedlineSection({ state, redline }: { state: string; redline: CaseFileData['redline'] }) {
  return <div className="card block prose"><h3>Redline · internal posture</h3><p className="muted">State and federal consumer rights for this file. Not a homeowner lecture.</p><p><b>{state || 'State'} consumer rights</b></p><ul>{redline.state.map((t, i) => <li key={i}>{t}</li>)}</ul><p><b>Federal consumer rights</b></p><ul>{redline.federal.map((t, i) => <li key={i}>{t}</li>)}</ul></div>
}

/**
 * Closer brief with the two packet PDFs and Approve / Edit. `readOnly` hides
 * every button: the PDF route and both brief actions check the client's scope,
 * which a desk reader outside it doesn't have.
 */
export function CloserBriefSection({ file, busy, readOnly = false, onApprove, onEdit }: {
  file: Pick<CaseFileData, 'id' | 'firstName' | 'lastName' | 'city' | 'state' | 'ownerName' | 'brief'>
  busy: boolean
  readOnly?: boolean
  onApprove?: () => void
  onEdit?: () => void
}) {
  return <div className="card block prose" style={{ marginTop: 14 }}><h3>Closer brief {file.brief?.approved ? '· approved' : ''}</h3><p>{file.firstName} {file.lastName}{[file.city, file.state].filter(Boolean).length ? ` · ${[file.city, file.state].filter(Boolean).join(', ')}` : ''}. {file.ownerName ? `Closer: ${file.ownerName}.` : 'No closer assigned.'} Case review is what you show the client. Closer pitch is how you run the call.</p>{readOnly
    ? <p className="muted" data-testid="brief-read-only">Read-only from the dialer. The PDFs, Approve and Edit are for the file&apos;s closer or an admin.</p>
    : <div className="actions" style={{ marginTop: 10 }}><a className="btn" href={`/api/clients/${file.id}/closer-packet?kind=review`}>Case review PDF</a><a className="btn secondary" href={`/api/clients/${file.id}/closer-packet?kind=pitch`}>Closer pitch PDF</a><button className="btn" disabled={busy || !file.brief} onClick={onApprove}>{file.brief?.approved ? 'Approved' : 'Approve brief'}</button><button className="btn secondary" disabled={busy || !file.brief} onClick={onEdit}>Edit</button></div>}</div>
}

/** Sends one file to the documents route. Returns the toast line, or an error. */
export async function uploadDocumentFile(clientId: string, tile: Pick<CaseDocTile, 'label' | 'requirementId'>, selected: File): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const body = new FormData(); body.set('clientId', clientId); body.set('file', selected); body.set('label', tile.label); if (tile.requirementId) body.set('requirementId', tile.requirementId)
  const response = await fetch('/api/documents/upload', { method: 'POST', body }); const result = await response.json(); if (!response.ok) return { ok: false, error: result.error || 'Upload failed' }; return { ok: true, message: result.extraction?.status === 'FAILED' ? 'Original saved; extraction needs attention' : `${selected.name} uploaded · ${tile.label}` }
}

export const UPLOAD_ACCEPT = '.pdf,.png,.jpg,.jpeg,.heic,.webp,.txt,.eml'
