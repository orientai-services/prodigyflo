'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import {
  recordCallCenterAttempt,
  recordCallCenterText,
  revealCallCenterContact,
  saveCallCenterNote,
  saveCallCenterOutcome,
  sendCallCenterIntakeLink,
  skipCallCenterLead,
  takeCallCenterLead,
} from '@/lib/call-center/actions'
import type { DeskResult } from '@/lib/call-center/desk-types'
import type { MissedCallVM, TwilioStatusVM } from '@/lib/telephony/voice-contract'
import type { PhoneSetupVM } from '@/lib/telephony/ui/phone-setup-data'
import { CallButton } from '@/components/voice/call-button'
import { RecordingPlayer } from '@/components/voice/recording-player'
import { useVoice } from '@/components/voice/voice-provider'
import { MissedCalls } from '@/components/telephony/missed-calls'
import { PhoneSetupSheet } from '@/components/telephony/phone-setup-sheet'
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

function Person({ lead, rep, onOpen }: { lead: CallLead; rep: string; onOpen: (lead: CallLead) => void }) {
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
      {lockLabel(lead, rep) ? <span className="mini">{lockLabel(lead, rep)}</span> : null}
    </button>
  )
}

/** Server-side phone context for the desk. Everything optional so the seed-only desk still renders. */
export type CallCenterPhone = {
  /** Why browser calling is off (plain English), or null when it is on. */
  voiceNote?: string | null
  missed?: MissedCallVM[]
  /** `?missed=<id>`: open the Missed tab on that row. */
  openMissedId?: string | null
  /** `?lead=<id>`: open that lead. */
  openLeadId?: string | null
  /** Holds telephony:manage; may stretch a narrowed calling window with a reason. */
  canOverrideHours?: boolean
  /** SUPER_ADMIN only: the Phone setup sheet. */
  setup?: { vm: PhoneSetupVM; status: TwilioStatusVM | null } | null
}

export function CallCenter({
  initialLeads,
  viewerId,
  phone = {},
}: {
  initialLeads?: CallLead[]
  viewerId?: string
  phone?: CallCenterPhone
}) {
  const router = useRouter()
  const voice = useVoice()
  const [draft, setDraft] = useState<{ source: CallLead[] | undefined; leads: CallLead[] } | null>(null)
  const [tab, setTab] = useState<LeadTab>('all')
  const [missedView, setMissedView] = useState(Boolean(phone.openMissedId))
  const [openMissedId, setOpenMissedId] = useState<string | null>(phone.openMissedId ?? null)
  const [language, setLanguage] = useState<LanguageFilter>('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(phone.openLeadId ?? null)
  const missed = phone.missed ?? []
  const [now, setNow] = useState<string | null>(null)
  const [callAnywayId, setCallAnywayId] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [dial, setDial] = useState<{ leadId: string; phone: string | null; email: string | null } | null>(null)
  const [deskError, setDeskError] = useState<string | null>(null)
  const leads = draft && draft.source === initialLeads ? draft.leads : (initialLeads ?? seedLeads())

  function replace(next: CallLead) {
    setDraft({
      source: initialLeads,
      leads: leads.map((lead) => (lead.id === next.id ? next : lead)),
    })
  }

  function stamp(): string {
    const at = new Date().toISOString()
    setNow(at)
    return at
  }

  function repFor(lead: CallLead): string {
    return lead.persisted ? (viewerId ?? '') : CURRENT_REP
  }

  function holding(lead: CallLead): boolean {
    if (!lead.persisted) return true
    return Boolean(viewerId) && lead.lockedBy === viewerId
  }

  async function commit(lead: CallLead, run: () => Promise<DeskResult>, local: () => void): Promise<boolean> {
    if (!lead.persisted) {
      local()
      return true
    }
    const result = await run()
    if (result.ok) {
      replace(result.lead)
      setDeskError(null)
      router.refresh()
      return true
    }
    setDeskError(result.error)
    return false
  }

  const rows = visibleLeads(leads, tab, language, query)
  const selected = rows.find((lead) => lead.id === selectedId && !lead.disabled) ?? null
  const who = selected ? repFor(selected) : CURRENT_REP
  const quietBlocked = Boolean(selected && now && callNeedsConfirm(selected, now) && callAnywayId !== selected.id)
  const revealLeadId = selected?.persisted && viewerId && selected.lockedBy === viewerId && !selected.dnc
    ? selected.id
    : null
  const dialPhone = revealLeadId && dial?.leadId === revealLeadId ? dial.phone : null
  const dialEmail = revealLeadId && dial?.leadId === revealLeadId ? dial.email : null

  useEffect(() => {
    if (!revealLeadId) return
    let cancel = false
    revealCallCenterContact(revealLeadId).then((contact) => {
      if (!cancel) setDial({ leadId: revealLeadId, phone: contact.phone, email: contact.email })
    }).catch(() => {
      if (!cancel) setDial({ leadId: revealLeadId, phone: null, email: null })
    })
    return () => {
      cancel = true
    }
  }, [revealLeadId])

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
    const next = nextCallableLead(rows, selected.id, who)
    if (next && next.id !== selected.id) openLead(next)
  }

  async function skipSelected() {
    if (!selected) return
    if (selected.persisted && holding(selected)) {
      const ok = await commit(selected, () => skipCallCenterLead(selected.id), () => {})
      if (!ok) return
    }
    jump()
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
              <span className="voice">
                {voice
                  ? voice.setup.mode === 'mock'
                    ? 'Test mode. No real calls are placed.'
                    : 'Browser calling on'
                  : (phone.voiceNote ?? 'Voice not connected')}
              </span>
              {phone.setup ? <PhoneSetupSheet setup={phone.setup.vm} status={phone.setup.status} /> : null}
            </div>
          </header>
          <main className="main">
            {!voice ? <div className="banner" role="status">{PREVIEW_BANNER}</div> : null}
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
                  aria-selected={!missedView && tab === item.id}
                  className={!missedView && tab === item.id ? 'on' : ''}
                  onClick={() => {
                    setMissedView(false)
                    setTab(item.id)
                  }}
                >
                  {item.label}
                </button>
              ))}
              <button
                type="button"
                role="tab"
                aria-selected={missedView}
                className={missedView ? 'on' : ''}
                onClick={() => setMissedView(true)}
              >
                Missed{missed.length ? ` (${missed.length})` : ''}
              </button>
            </div>
            {missedView ? (
              <div className="card">
                <MissedCalls calls={missed} openId={openMissedId} canOverrideHours={phone.canOverrideHours} />
              </div>
            ) : (
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
                        <td><Person lead={lead} rep={repFor(lead)} onOpen={openLead} /></td>
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
                      {lockLabel(selected, who) ? <span className="tag">{lockLabel(selected, who)}</span> : null}
                      {selected.dnc ? <span className="tag">Do not call</span> : null}
                    </div>
                    <h2 className="who">{selected.name}</h2>
                    {deskError ? <p className="muted" role="status">{deskError}</p> : null}
                    <dl className="facts">
                      <div><dt>Page</dt><dd>{selected.page}</dd></div>
                      <div><dt>ZIP</dt><dd>{selected.zip ?? '—'}</dd></div>
                      {/* Plain text, never a tel: link: every dial goes through the server check behind Call. */}
                      <div><dt>Phone</dt><dd>{dialPhone ?? phoneLabel(selected)}</dd></div>
                      {dialEmail ? <div><dt>Email</dt><dd>{dialEmail}</dd></div> : null}
                      <div><dt>Tries</dt><dd>{triesLine(selected)}</dd></div>
                      {nextTryLine(selected) ? <div><dt>Next try</dt><dd>{nextTryLine(selected)}</dd></div> : null}
                      {inboundFormMatch(selected, leads) ? <div><dt>Match</dt><dd>{inboundFormMatch(selected, leads)}</dd></div> : null}
                    </dl>
                    {selected.missedCallId ? (
                      <div className="banner" role="status">
                        <button
                          type="button"
                          className="linkish"
                          onClick={() => {
                            setOpenMissedId(selected.missedCallId ?? null)
                            setMissedView(true)
                          }}
                        >
                          Missed call waiting. Open it.
                        </button>
                      </div>
                    ) : null}
                    {!selected.persisted && now && callNeedsConfirm(selected, now) ? (
                      <div className="banner quiet" role="status">
                        <span>{QUIET_BANNER}</span>
                        <button
                          type="button"
                          className="btn secondary"
                          disabled={!canCall(selected, who) || !holding(selected)}
                          onClick={() => setCallAnywayId(selected.id)}
                        >
                          Call anyway
                        </button>
                      </div>
                    ) : null}
                    <h3>Queue</h3>
                    <div className="actions">
                      <button type="button" className="btn secondary" disabled={!canTake(selected, who)} onClick={() => { void commit(selected, () => takeCallCenterLead(selected.id), () => replace(takeLead(selected, CURRENT_REP, stamp()))) }}>Take</button>
                      <button type="button" className="btn secondary" onClick={() => { void skipSelected() }}>Skip</button>
                      <button type="button" className="btn secondary" onClick={jump}>Next</button>
                    </div>
                    <h3>Contact</h3>
                    <div className="actions">
                      {selected.persisted ? (
                        <CallButton
                          key={selected.id}
                          appearance="desk"
                          target={{ kind: 'lead', id: selected.id }}
                          tel={dialPhone}
                          who={selected.name}
                          canOverrideHours={phone.canOverrideHours}
                          disabled={!canCall(selected, who) || !holding(selected)}
                          onDialed={(via) => {
                            // A browser call is written by the carrier webhooks; only the
                            // tel: flow records its own attempt.
                            if (via === 'tel') void commit(selected, () => recordCallCenterAttempt(selected.id), () => {})
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className="btn"
                          disabled={!canCall(selected, who) || !holding(selected) || quietBlocked}
                          onClick={() => replace(applyLeadAction(selected, 'call', stamp()))}
                        >
                          Call
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={!canText(selected, who) || !holding(selected)}
                        onClick={() => { void commit(selected, () => recordCallCenterText(selected.id), () => replace(applyLeadAction(selected, 'text', stamp()))) }}
                      >
                        Text
                      </button>
                    </div>
                    {selected.persisted ? <p className="muted">Texting leads isn&rsquo;t live yet.</p> : null}
                    {now && textHeldUntilMorning(selected, now) ? <p className="muted">{HELD_UNTIL_MORNING}</p> : null}
                    <h3>Result</h3>
                    <div className="actions">
                      {OUTCOMES.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className="btn secondary"
                          disabled={!canRecordOutcome(selected, who) || !holding(selected)}
                          onClick={() => { void commit(selected, () => saveCallCenterOutcome(selected.id, item.id), () => replace(applyOutcome(selected, item.id, stamp()))) }}
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
                        disabled={!canSendIntake(selected, who) || !holding(selected)}
                        onClick={() => { void commit(selected, () => sendCallCenterIntakeLink(selected.id), () => replace(sendIntakeLink(selected, stamp()))) }}
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
                      disabled={!canSaveNote(selected, who) || !holding(selected)}
                      onChange={(event) => setNote(event.target.value)}
                    />
                    <div className="actions">
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={!canSaveNote(selected, who) || !holding(selected)}
                        onClick={() => {
                          const text = note
                          void commit(
                            selected,
                            () => saveCallCenterNote(selected.id, text),
                            () => replace(saveNote(selected, text, stamp())),
                          ).then((ok) => { if (ok) setNote('') })
                        }}
                      >
                        Save note
                      </button>
                    </div>
                    <h3>Comms</h3>
                    <ol className="trail">
                      {selected.trail.map((event, index) => (
                        <li key={`${event.at}-${event.kind}-${index}`}>
                          <time dateTime={event.at}>{formatWhen(event.at)}</time>
                          <b>{event.label}</b>
                          <div className="muted">{event.detail}</div>
                          {event.recording ? (
                            <RecordingPlayer src={event.recording.src} seconds={event.recording.seconds} className="mt-1.5" />
                          ) : null}
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
            )}
          </main>
        </div>
      </div>
    </div>
  )
}
