'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import {
  CALL_CENTER_COPY,
  CURRENT_REP,
  HELD_UNTIL_MORNING,
  OUTCOMES,
  PREVIEW_BANNER,
  QUIET_BANNER,
  applyLeadAction,
  applyOutcome,
  badgeLabel,
  callNeedsConfirm,
  canCall,
  canRecordOutcome,
  canSaveNote,
  canSendIntake,
  canTake,
  canText,
  channelLabel,
  formatWhen,
  hasCall,
  inboundFormMatch,
  languageLabel,
  lockLabel,
  nextCallableLead,
  nextTryLine,
  phoneLabel,
  saveNote,
  seedLeads,
  sendIntakeLink,
  takeLead,
  textHeldUntilMorning,
  triesLine,
  visibleLeads,
  type CallLead,
  type LanguageFilter,
  type LeadTab,
} from '@/lib/call-center/model'
import '../final-desk/final-desk.css'
import './call-center.css'

const RAIL = [
  { href: '/board', label: 'Board' },
  { href: '/pipeline', label: 'Pipeline' },
  { href: '/clients', label: 'Clients' },
  { href: '/queue', label: 'Queue' },
  { href: '/call-center', label: 'Call Center' },
  { href: '/documents', label: 'Document lab' },
  { href: '/submissions', label: 'CYS' },
] as const

const TABS: { id: LeadTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'forms', label: 'Forms' },
  { id: 'inbound', label: 'Inbound' },
  { id: 'uncontacted', label: 'Not contacted' },
  { id: 'retry', label: 'Retry' },
  { id: 'dnc', label: 'Do not call' },
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
        {lead.tries ? ` · ${triesLine(lead)}` : ''}
      </span>
      {lead.dnc ? <span className="mini">Do not call</span> : null}
      {lockLabel(lead) ? <span className="mini">{lockLabel(lead)}</span> : null}
    </button>
  )
}

export function CallCenter() {
  const [leads, setLeads] = useState(seedLeads)
  const [tab, setTab] = useState<LeadTab>('all')
  const [language, setLanguage] = useState<LanguageFilter>('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [now, setNow] = useState<string | null>(null)
  const [callAnywayId, setCallAnywayId] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const rows = visibleLeads(leads, tab, language, query)
  const selected = rows.find((lead) => lead.id === selectedId && !lead.disabled) ?? null

  function replace(next: CallLead) {
    setLeads((current) => current.map((lead) => (lead.id === next.id ? next : lead)))
  }

  function stamp(): string {
    const at = new Date().toISOString()
    setNow(at)
    return at
  }

  function chooseLanguage(next: LanguageFilter) {
    setLanguage(next)
    if (next === 'es') setTab('all')
  }

  function openLead(lead: CallLead) {
    if (lead.disabled) return
    setSelectedId(lead.id)
    setNote('')
    setNow(new Date().toISOString())
  }

  function jump() {
    if (!selected) return
    const next = nextCallableLead(rows, selected.id)
    if (next && next.id !== selected.id) openLead(next)
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
            {RAIL.map((item) =>
              item.href === '/call-center' ? (
                <Link key={item.href} href={item.href} className="here" aria-current="page">{item.label}</Link>
              ) : (
                <Link key={item.href} href={item.href}>{item.label}</Link>
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
                        className={['row', lead.disabled || lead.dnc ? 'dead' : '', selectedId === lead.id ? 'on' : ''].filter(Boolean).join(' ')}
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
                      {lockLabel(selected) ? <span className="tag">{lockLabel(selected)}</span> : null}
                      {selected.dnc ? <span className="tag">Do not call</span> : null}
                    </div>
                    <h2 className="who">{selected.name}</h2>
                    <dl className="facts">
                      <div><dt>Page</dt><dd>{selected.page}</dd></div>
                      <div><dt>ZIP</dt><dd>{selected.zip ?? '—'}</dd></div>
                      <div><dt>Phone</dt><dd>{phoneLabel(selected)}</dd></div>
                      <div><dt>Tries</dt><dd>{triesLine(selected)}</dd></div>
                      {nextTryLine(selected) ? <div><dt>Next try</dt><dd>{nextTryLine(selected)}</dd></div> : null}
                      {inboundFormMatch(selected, leads) ? <div><dt>Match</dt><dd>{inboundFormMatch(selected, leads)}</dd></div> : null}
                    </dl>
                    {now && callNeedsConfirm(selected, now) ? (
                      <div className="banner quiet" role="status">
                        <span>{QUIET_BANNER}</span>
                        <button
                          type="button"
                          className="btn secondary"
                          disabled={!canCall(selected)}
                          onClick={() => setCallAnywayId(selected.id)}
                        >
                          Call anyway
                        </button>
                      </div>
                    ) : null}
                    <h3>Queue</h3>
                    <div className="actions">
                      <button type="button" className="btn secondary" disabled={!canTake(selected)} onClick={() => replace(takeLead(selected, CURRENT_REP, stamp()))}>Take</button>
                      <button type="button" className="btn secondary" onClick={jump}>Skip</button>
                      <button type="button" className="btn secondary" onClick={jump}>Next</button>
                    </div>
                    <h3>Contact</h3>
                    <div className="actions">
                      <button
                        type="button"
                        className="btn"
                        disabled={!canCall(selected) || (now != null && callNeedsConfirm(selected, now) && callAnywayId !== selected.id)}
                        onClick={() => replace(applyLeadAction(selected, 'call', stamp()))}
                      >
                        Call
                      </button>
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={!canText(selected)}
                        onClick={() => replace(applyLeadAction(selected, 'text', stamp()))}
                      >
                        Text
                      </button>
                    </div>
                    {now && textHeldUntilMorning(selected, now) ? <p className="muted">{HELD_UNTIL_MORNING}</p> : null}
                    <h3>Result</h3>
                    <div className="actions">
                      {OUTCOMES.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className="btn secondary"
                          disabled={!canRecordOutcome(selected)}
                          onClick={() => replace(applyOutcome(selected, item.id, stamp()))}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                    <h3>Handoff</h3>
                    <div className="actions">
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={!canSendIntake(selected)}
                        onClick={() => replace(sendIntakeLink(selected, stamp()))}
                      >
                        Send intake link
                      </button>
                    </div>
                    <h3>Note</h3>
                    <textarea
                      className="note"
                      value={note}
                      placeholder="Note on this attempt"
                      aria-label="Note on this attempt"
                      disabled={!canSaveNote(selected)}
                      onChange={(event) => setNote(event.target.value)}
                    />
                    <div className="actions">
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={!canSaveNote(selected)}
                        onClick={() => {
                          replace(saveNote(selected, note, stamp()))
                          setNote('')
                        }}
                      >
                        Save note
                      </button>
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
