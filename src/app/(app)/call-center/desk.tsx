'use client'

import { useMemo, useState } from 'react'
import { DeskChrome } from '@/components/desk/desk-chrome'
import type { ApproachLanguage, CallCenterLead, CallCenterQueue } from '@/lib/call-center/types'

const LANGS: { id: ApproachLanguage | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'en', label: 'English desk' },
  { id: 'es', label: 'Spanish desk' },
]

const QUEUES: { id: CallCenterQueue | 'all'; label: string }[] = [
  { id: 'all', label: 'All queues' },
  { id: 'new', label: 'New forms' },
  { id: 'inbound', label: 'Inbound' },
  { id: 'missed', label: 'Missed' },
  { id: 'booked', label: 'Booked' },
]

export function CallCenterDesk({ initial }: { initial: CallCenterLead[] }) {
  const [leads, setLeads] = useState(initial)
  const [lang, setLang] = useState<ApproachLanguage | 'all'>('all')
  const [queue, setQueue] = useState<CallCenterQueue | 'all'>('all')
  const [sel, setSel] = useState(initial[0]?.id ?? '')
  const [banner, setBanner] = useState(
    'Door 2 only. Facebook forms and the number on those ads. Twilio and Meta are not plugged in.',
  )

  const visible = useMemo(
    () => leads.filter((l) => (lang === 'all' || l.approachLanguage === lang) && (queue === 'all' || l.queue === queue)),
    [leads, lang, queue],
  )
  const selected = visible.find((l) => l.id === sel) ?? visible[0]

  async function act(id: string, action: 'call' | 'sms' | 'book' | 'missed') {
    const res = await fetch(`/api/call-center/leads/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    const data = await res.json()
    if (!res.ok) {
      setBanner(data.error ?? 'Action failed')
      return
    }
    setLeads((prev) => prev.map((l) => (l.id === data.lead.id ? data.lead : l)))
    setBanner(data.message)
  }

  return (
    <DeskChrome
      title="Call Center"
      description="People who filled an SES English or SES Spanish ad form, or called the number on that ad. Journey clients stay on Clients."
    >
      <p className="desk-banner">{banner}</p>
      <div className="desk-actions-row" style={{ marginBottom: 16 }}>
        {LANGS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="desk-btn-secondary"
            style={lang === item.id ? { background: 'var(--desk-teal-soft)' } : undefined}
            onClick={() => setLang(item.id)}
          >
            {item.label}
          </button>
        ))}
        {QUEUES.map((item) => (
          <button
            key={item.id}
            type="button"
            className="desk-btn-secondary"
            style={queue === item.id ? { background: 'var(--desk-teal-soft)' } : undefined}
            onClick={() => setQueue(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <section className="desk-card desk-block">
        <table className="desk-table">
          <thead>
            <tr>
              <th>Approach</th>
              <th>Name</th>
              <th>Source</th>
              <th>Queue</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={5} className="desk-muted">
                  Nothing in this filter.
                </td>
              </tr>
            ) : (
              visible.map((row) => (
                <tr key={row.id} data-selected={selected?.id === row.id ? 'true' : undefined}>
                  <td>
                    {row.approachLanguage.toUpperCase()}
                    {row.inbound ? ' · inbound' : ''}
                  </td>
                  <td className="font-medium">{row.name}</td>
                  <td>
                    {row.sourcePageName}
                    <div className="desk-muted">{row.adName}</div>
                  </td>
                  <td>{row.queue}</td>
                  <td>
                    <div className="desk-actions-row" style={{ justifyContent: 'flex-end' }}>
                      <button type="button" className="desk-btn-secondary" onClick={() => setSel(row.id)}>
                        Open
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      {selected ? (
        <section className="desk-card desk-block" style={{ marginTop: 16, padding: 18 }}>
          <h2 className="font-heading" style={{ fontSize: 24, margin: 0 }}>
            {selected.name}
          </h2>
          <p className="desk-muted">Call Center lead · not an SCS journey client</p>
          <p>
            {selected.approachLanguage === 'en' ? 'English approach · SES English page' : 'Spanish approach · SES Spanish page'}
          </p>
          <p className="desk-muted">{selected.adName}</p>
          <p>ZIP {selected.zip || '—'} · phone hidden · last4 {selected.phoneLast4}</p>
          <p>{selected.note}</p>
          <div className="desk-actions-row" style={{ marginTop: 12 }}>
            <button type="button" className="desk-btn-secondary" onClick={() => void act(selected.id, 'call')}>
              Call
            </button>
            <button type="button" className="desk-btn-secondary" onClick={() => void act(selected.id, 'sms')}>
              Text
            </button>
            <button type="button" className="desk-btn-secondary" onClick={() => void act(selected.id, 'book')}>
              Book callback
            </button>
            <button type="button" className="desk-btn-secondary" onClick={() => void act(selected.id, 'missed')}>
              Missed
            </button>
          </div>
        </section>
      ) : null}
    </DeskChrome>
  )
}
