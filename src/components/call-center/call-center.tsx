'use client'

import { useEffect, useState } from 'react'
import {
  CALL_CENTER_COPY,
  PREVIEW_BANNER,
  applyLeadAction,
  badgeLabel,
  channelLabel,
  formatWhen,
  hasCall,
  languageLabel,
  seedLeads,
  visibleLeads,
  type CallLead,
  type LanguageFilter,
  type LeadAction,
  type LeadTab,
} from '@/lib/call-center/model'
import '../final-desk/final-desk.css'
import './call-center.css'

const RAIL = ['Board', 'Pipeline', 'Clients', 'Queue', 'Call Center', 'Document lab', 'CYS'] as const

const TABS: { id: LeadTab; label: string }[] = [
  { id: 'all', label: 'All leads' },
  { id: 'forms', label: 'Forms' },
  { id: 'inbound', label: 'Inbound' },
  { id: 'uncontacted', label: 'Not contacted' },
  { id: 'missed', label: 'Missed' },
  { id: 'booked', label: 'Booked' },
]

function clock(total: number): string {
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function Recording({ seconds, label }: { seconds: number; label: string }) {
  const [playing, setPlaying] = useState(false)
  const [at, setAt] = useState(0)

  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      setAt((current) => {
        if (current + 1 >= seconds) {
          setPlaying(false)
          return seconds
        }
        return current + 1
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [playing, seconds])

  return (
    <div className="player">
      <button
        type="button"
        className="btn secondary"
        onClick={() => {
          if (at >= seconds) setAt(0)
          setPlaying((on) => !on)
        }}
      >
        {playing ? 'Pause' : 'Play'}
      </button>
      <div>
        <div className="track" aria-hidden="true"><i style={{ width: `${seconds ? (at / seconds) * 100 : 0}%` }} /></div>
        <small>{label} · {clock(at)} / {clock(seconds)} · play is a preview</small>
      </div>
      <span className="sr">No audio file is loaded.</span>
    </div>
  )
}

function Person({ lead, onOpen }: { lead: CallLead; onOpen: (lead: CallLead) => void }) {
  return (
    <button type="button" className="person" disabled={lead.disabled} onClick={() => onOpen(lead)}>
      <b>{lead.name}</b>
      {lead.subtitle ? <span>{lead.subtitle}</span> : null}
      <span>
        {languageLabel(lead.language)}
        {lead.last4 ? ` · ${lead.last4}` : ''}
      </span>
    </button>
  )
}

export function CallCenter() {
  const [leads, setLeads] = useState(seedLeads)
  const [tab, setTab] = useState<LeadTab>('all')
  const [language, setLanguage] = useState<LanguageFilter>('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const rows = visibleLeads(leads, tab, language, query)
  const selected = rows.find((lead) => lead.id === selectedId && !lead.disabled) ?? null

  function act(action: LeadAction) {
    if (!selected) return
    const at = new Date().toISOString()
    setLeads((current) => current.map((lead) => (lead.id === selected.id ? applyLeadAction(lead, action, at) : lead)))
  }

  function chooseLanguage(next: LanguageFilter) {
    setLanguage(next)
    if (next === 'es') setTab('all')
  }

  function openLead(lead: CallLead) {
    if (lead.disabled) return
    setSelectedId(lead.id)
  }

  return (
    <div className="final-desk call-center">
      <div className="shell">
        <aside className="rail">
          <div className="brand">
            <small>SCS operations</small>
            <strong>Prodigy<span className="flo">Flo</span></strong>
          </div>
          <nav className="nav" aria-label="Desk">
            {RAIL.map((label) =>
              label === 'Call Center' ? (
                <span key={label} className="here" aria-current="page">{label}</span>
              ) : (
                <span key={label} className="dead">{label}</span>
              ),
            )}
          </nav>
        </aside>
        <div className="col">
          <header className="top">
            <label className="search">
              <span className="sr">Search leads</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search leads"
                aria-label="Search leads"
              />
            </label>
            <div className="top-right">
              <label className="lang">
                Working language
                <select
                  aria-label="Working language"
                  value={language}
                  onChange={(event) => chooseLanguage(event.target.value as LanguageFilter)}
                >
                  <option value="all">All</option>
                  <option value="en">English</option>
                  <option value="es">Spanish page later</option>
                </select>
              </label>
              <span className="voice">Voice not connected</span>
            </div>
          </header>
          <main className="main">
            <div className="banner" role="status">{PREVIEW_BANNER}</div>
            <div className="page-title">
              <h2>Call Center</h2>
              <p className="muted">{CALL_CENTER_COPY}</p>
            </div>
            <div className="filters" role="tablist" aria-label="Lead filters">
              {TABS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === item.id}
                  className={tab === item.id ? 'on' : ''}
                  onClick={() => setTab(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="split">
              <div className="card">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Person</th>
                      <th scope="col">Came in as</th>
                      <th scope="col">Contacted</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((lead) => (
                      <tr
                        key={lead.id}
                        className={lead.disabled ? 'dead' : selectedId === lead.id ? 'row on' : 'row'}
                        aria-selected={selectedId === lead.id}
                        onClick={() => openLead(lead)}
                      >
                        <td>{formatWhen(lead.arrivedAt)}</td>
                        <td><Person lead={lead} onOpen={openLead} /></td>
                        <td>{channelLabel(lead.channel)}</td>
                        <td>{lead.contacted ? 'Yes' : 'No'}</td>
                        <td>{lead.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!rows.length && <p className="block muted">No leads in this view.</p>}
              </div>
              <article className="card block">
                {selected ? (
                  <>
                    <div className="tags">
                      <span className="tag">{badgeLabel(selected.channel)}</span>
                      <span className="tag">{languageLabel(selected.language)}</span>
                      <span className={`tag ${selected.contacted ? 'g' : 'w'}`}>{selected.contacted ? 'Contacted' : 'Not contacted'}</span>
                      <span className="tag">{selected.status}</span>
                    </div>
                    <h2 className="who">{selected.name}</h2>
                    <dl className="facts">
                      <div><dt>Page</dt><dd>{selected.page}</dd></div>
                      <div><dt>ZIP</dt><dd>{selected.zip ?? '—'}</dd></div>
                      <div><dt>Phone</dt><dd>{selected.last4 ? `···· ${selected.last4}` : '—'}</dd></div>
                      <div><dt>Contacted</dt><dd>{selected.contacted ? 'Yes' : 'No'}</dd></div>
                    </dl>
                    <div className="actions">
                      <button type="button" className="btn" onClick={() => act('call')}>Call</button>
                      <button type="button" className="btn secondary" onClick={() => act('text')}>Text</button>
                      <button type="button" className="btn secondary" onClick={() => act('book')}>Book callback</button>
                      <button type="button" className="btn secondary" onClick={() => act('missed')}>Missed</button>
                    </div>
                    {hasCall(selected) && (
                      <Recording
                        key={`${selected.id}:${selected.recording?.seconds ?? 0}:${selected.trail.length}`}
                        seconds={selected.recording?.seconds ?? 8}
                        label={selected.recording?.label ?? 'Dummy recording'}
                      />
                    )}
                    <h3>Comms</h3>
                    <ol className="trail">
                      {selected.trail.map((event, index) => (
                        <li key={`${event.at}-${event.kind}-${index}`}>
                          <time dateTime={event.at}>{formatWhen(event.at)}</time>
                          <b>{event.label}</b>
                          <div className="muted">{event.detail}</div>
                        </li>
                      ))}
                    </ol>
                  </>
                ) : (
                  <>
                    <h2 className="who">Select a lead</h2>
                    <p className="muted">Click a row. The Spanish page placeholder stays disabled.</p>
                  </>
                )}
              </article>
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}
