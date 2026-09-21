'use client'

import { useState } from 'react'
import { PdfPreview } from '@/components/client/pdf-preview'
import type { CaseDocFile, CaseDocTile } from '@/lib/daily-desk-case-types'

/** Keep every original/version, including kinds outside the eight profile modules. */
export function quicklookFiles(tile: CaseDocTile, allFiles: CaseDocFile[]): CaseDocFile[] {
  return [...new Map([...tile.files, ...allFiles].map(file => [file.id, file])).values()]
}

/** Baseline Quicklook presentation; multiple originals require only a file selector. */
export function DocumentQuicklook({ tile, allFiles, clientLabel, firstName, onClose, onRequest }: {
  tile: CaseDocTile
  allFiles: CaseDocFile[]
  clientLabel: string
  firstName: string
  onClose: () => void
  onRequest: () => void
}) {
  const files = quicklookFiles(tile, allFiles)
  const [selected, setSelected] = useState(tile.documentId ?? tile.files[0]?.id ?? '')
  const current = files.find(file => file.id === selected)
  const fileUrl = current?.fileUrl ?? (selected === tile.documentId ? tile.fileUrl : null)
  const mimeType = current ? current.mimeType : tile.mimeType
  const title = current && selected !== tile.documentId ? current.label : tile.label
  const status = current && selected !== tile.documentId ? current.status.toLowerCase().replaceAll('_', ' ') : tile.state
  const needsSelector = files.length > 1 || (!tile.documentId && files.length > 0)

  return <div className="modal on" onClick={event => { if (event.currentTarget === event.target) onClose() }}><div className="lookbox">
    <div className="lookhead"><div><div className="muted" style={{ fontSize: 11, letterSpacing: '.12em', textTransform: 'uppercase' }}>Quick look</div><h3>{title}</h3><div className="muted">{clientLabel} · {status}</div></div><button className="btn secondary" onClick={onClose}>Close</button></div>
    {needsSelector && <div style={{ padding: '12px 16px 0' }}><select aria-label="Document and version" value={selected} onChange={event => setSelected(event.target.value)} style={{ maxWidth: '100%' }}>
      {!selected && <option value="">Choose an uploaded file</option>}
      {files.map(file => <option key={file.id} value={file.id}>{file.label} · v{file.version} · {file.status.toLowerCase().replaceAll('_', ' ')}</option>)}
    </select></div>}
    {fileUrl ? <div style={{ width: '100%', height: '65vh', overflow: 'auto', padding: 16 }}>{mimeType === 'application/pdf' ? <PdfPreview key={fileUrl} title={title} url={fileUrl} /> : <iframe title={title} src={fileUrl} style={{ width: '100%', height: '100%', border: 0 }} />}</div> : <div className="empty-look"><div className="v m" style={{ fontSize: 20 }}>Not on file</div><p>This document is not available for {firstName} yet.</p><button className="btn" onClick={onRequest}>Request {tile.label}</button></div>}
  </div></div>
}
