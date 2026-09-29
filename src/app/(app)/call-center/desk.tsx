'use client'

import { useMemo, useState } from 'react'
import type { ApproachLanguage, CallCenterLead, CallCenterQueue } from '@/lib/call-center/types'

const QUEUES: { id: CallCenterQueue | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
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
  const [banner, setBanner] = useState('Branch mock. Twilio and Facebook are not plugged in.')

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
    <div className="mx-auto max-w-6xl px-6 py-6">
      <p className="mb-4 rounded-md border border-amber-700/30 bg-amber-50 px-3 py-2 text-sm text-amber-950">
        {banner} Door 2 only — Facebook forms and the number on those ads. SCS journey clients stay on Clients.
      </p>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Call Center</h1>
          <p className="text-sm text-muted-foreground">EN / ES stamped from the Page. Not guessed from the name.</p>
        </div>
        <div className="flex gap-2">
          {(['all', 'en', 'es'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setLang(k)}
              className={`rounded-full border px-3 py-1 text-sm ${lang === k ? 'bg-foreground text-background' : ''}`}
            >
              {k === 'all' ? 'All' : k === 'en' ? 'English desk' : 'Spanish desk'}
            </button>
          ))}
        </div>
      </div>
      <div className="mb-4 flex gap-2">
        {QUEUES.map((q) => (
          <button
            key={q.id}
            type="button"
            onClick={() => setQueue(q.id)}
            className={`rounded-full border px-3 py-1 text-sm ${queue === q.id ? 'bg-foreground text-background' : ''}`}
          >
            {q.label}
          </button>
        ))}
      </div>
      <div className="grid gap-8 md:grid-cols-[1fr_320px]">
        <ul className="divide-y">
          {visible.map((l) => (
            <li key={l.id}>
              <button
                type="button"
                onClick={() => setSel(l.id)}
                className={`flex w-full items-start justify-between gap-4 py-3 text-left ${selected?.id === l.id ? 'bg-muted/40' : ''}`}
              >
                <div>
                  <div className="mb-1 flex flex-wrap gap-1 text-[11px] font-semibold tracking-wide">
                    <span className="rounded-full bg-muted px-2 py-0.5">{l.approachLanguage.toUpperCase()}</span>
                    <span className="rounded-full bg-muted px-2 py-0.5">FB FORM</span>
                    {l.inbound ? <span className="rounded-full bg-muted px-2 py-0.5">INBOUND</span> : null}
                    <span className="rounded-full bg-muted px-2 py-0.5">{l.queue}</span>
                  </div>
                  <div className="text-base font-medium">{l.name}</div>
                  <div className="text-sm text-muted-foreground">
                    {l.sourcePageName} · {l.adName} · …{l.phoneLast4}
                  </div>
                </div>
                <span className="shrink-0 text-sm underline">Open</span>
              </button>
            </li>
          ))}
        </ul>
        {selected ? (
          <aside className="rounded-lg border p-4">
            <div className="text-xs font-semibold tracking-wide">
              {selected.approachLanguage === 'en' ? 'ENGLISH APPROACH' : 'SPANISH APPROACH'}
            </div>
            <h2 className="mt-1 text-xl font-semibold">{selected.name}</h2>
            <p className="text-sm text-muted-foreground">Call Center lead · not an SCS journey client</p>
            <dl className="mt-4 grid grid-cols-[96px_1fr] gap-y-2 text-sm">
              <dt className="text-muted-foreground">Page</dt>
              <dd>{selected.sourcePageName}</dd>
              <dt className="text-muted-foreground">Ad</dt>
              <dd>{selected.adName}</dd>
              <dt className="text-muted-foreground">ZIP</dt>
              <dd>{selected.zip || '—'}</dd>
              <dt className="text-muted-foreground">Phone</dt>
              <dd>Hidden · last4 {selected.phoneLast4}</dd>
            </dl>
            <p className="mt-3 text-sm">{selected.note}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background" onClick={() => act(selected.id, 'call')}>
                Call
              </button>
              <button type="button" className="rounded-md border px-3 py-1.5 text-sm" onClick={() => act(selected.id, 'sms')}>
                Text
              </button>
              <button type="button" className="rounded-md border px-3 py-1.5 text-sm" onClick={() => act(selected.id, 'book')}>
                Book callback
              </button>
              <button type="button" className="rounded-md border px-3 py-1.5 text-sm" onClick={() => act(selected.id, 'missed')}>
                Missed
              </button>
            </div>
          </aside>
        ) : (
          <p className="text-sm text-muted-foreground">No Door 2 leads in this filter.</p>
        )}
      </div>
    </div>
  )
}
