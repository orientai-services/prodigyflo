'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { DocumentStatus } from '@prisma/client'
import { DeskChrome } from '@/components/desk/desk-chrome'
import { DeskQuickLook, type DeskLookFile } from '@/components/desk/desk-quick-look'
import { SlaIndicator } from '@/components/sla-indicator'
import { DocumentStatusBadge, ProviderBadge } from './status-badge'

export type DocumentLabFilter = { key: string; href: string; label: string; count: number }
export type DocumentLabStat = { label: string; value: string; hint: string }
export type DocumentLabRow = {
  id: string
  label: string
  sub: string
  clientId: string
  clientName: string
  status: DocumentStatus
  reviewed: number
  fieldCount: number
  conflicts: number
  provider: string | null
  model: string | null
  extractionStatus: string | null
  slaSince: string | null
  slaHours: number | null
  activity: string
  fileUrl: string | null
  mimeType: string | null
}

export function DocumentLabView({
  filters,
  activeFilter,
  stats,
  rows,
}: {
  filters: DocumentLabFilter[]
  activeFilter: string
  stats: DocumentLabStat[]
  rows: DocumentLabRow[]
}) {
  const [look, setLook] = useState<DeskLookFile | null>(null)

  return (
    <DeskChrome
      title="Document lab"
      description="Review queue with signed files. Quick look is the real file, or not on file — never a fabricated preview."
    >
      <div className="desk-pills">
        {filters.map((f) => (
          <Link key={f.key} href={f.href} className={`desk-pill${f.key === activeFilter ? ' on' : ''}`}>
            {f.label}
            <span>{f.count}</span>
          </Link>
        ))}
      </div>

      <div className="desk-stats">
        {stats.map((s) => (
          <div key={s.label} className="desk-stat">
            <span>{s.label}</span>
            <b>{s.value}</b>
            <i>{s.hint}</i>
          </div>
        ))}
      </div>

      {rows.length === 0 ? (
        <section className="desk-card desk-block">
          <p className="desk-empty">Nothing in this queue. Documents appear here when they are uploaded against a client.</p>
        </section>
      ) : (
        <section className="desk-card desk-block">
          <div className="scroll-x">
            <table className="desk-table">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Client</th>
                  <th>Status</th>
                  <th>Fields</th>
                  <th>Extraction</th>
                  <th>SLA</th>
                  <th>Activity</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link href={`/documents/${row.id}`}>{row.label}</Link>
                      <div className="desk-muted" style={{ marginBottom: 0 }}>
                        {row.sub}
                      </div>
                    </td>
                    <td>
                      <Link href={`/clients/${row.clientId}`}>{row.clientName}</Link>
                    </td>
                    <td>
                      <DocumentStatusBadge status={row.status} />
                    </td>
                    <td>
                      {row.fieldCount === 0 ? (
                        '—'
                      ) : (
                        <>
                          {row.reviewed}/{row.fieldCount}
                          {row.conflicts > 0 ? ` · ${row.conflicts} conflict${row.conflicts === 1 ? '' : 's'}` : ''}
                        </>
                      )}
                    </td>
                    <td>
                      {row.provider ? (
                        <ProviderBadge provider={row.provider} model={row.model} />
                      ) : (
                        <span className="desk-muted">Not run</span>
                      )}
                      {row.extractionStatus && row.extractionStatus !== 'COMPLETED' ? (
                        <div className="desk-muted" style={{ marginBottom: 0 }}>
                          {row.extractionStatus}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {row.slaSince && row.slaHours != null ? (
                        <SlaIndicator since={row.slaSince} slaHours={row.slaHours} />
                      ) : (
                        <span className="desk-muted">—</span>
                      )}
                    </td>
                    <td>{row.activity}</td>
                    <td>
                      <div className="desk-actions-row" style={{ justifyContent: 'flex-end' }}>
                        <button
                          type="button"
                          className="desk-btn-secondary"
                          onClick={() =>
                            setLook({
                              id: row.id,
                              label: row.label,
                              clientName: row.clientName,
                              fileUrl: row.fileUrl,
                              mimeType: row.mimeType,
                            })
                          }
                        >
                          Look
                        </button>
                        <Link href={`/documents/${row.id}`} className="desk-btn-secondary">
                          Review
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <DeskQuickLook look={look} onClose={() => setLook(null)} />
    </DeskChrome>
  )
}
