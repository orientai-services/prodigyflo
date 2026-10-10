'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
import { leadIdOfTarget } from '@/lib/call-center/lead-link'
import { todayBoard } from '@/lib/call-center/priority'
import { SHORTCUTS, type DeskKeyAction } from '@/lib/call-center/shortcuts'
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
  isExhausted,
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
  type LeadOutcome,
  type LeadTab,
} from '@/lib/call-center/model'
import { CallbackScheduler } from './callback-scheduler'
import { PowerBar, WrapUp } from './power-panel'
import { TodayView } from './today-view'
import { useDeskClock, useDeskKeys, useLiveRefresh } from './use-desk-effects'
import { usePowerMode } from './use-power-mode'
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

type DeskView = 'today' | 'list' | 'missed'

/** Below this width the lead opens as a full-screen panel instead of the split view. */
const PHONE_QUERY = '(max-width: 767.98px)'

function onPhone(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(PHONE_QUERY).matches
}

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
  renderedAt,
}: {
  initialLeads?: CallLead[]
  viewerId?: string
  phone?: CallCenterPhone
  /** The server's clock when it rendered, so the first Today ranking matches on both sides. */
  renderedAt?: string
}) {
  const router = useRouter()
  const voice = useVoice()
  const [draft, setDraft] = useState<{ source: CallLead[] | undefined; leads: CallLead[] } | null>(null)
  const [tab, setTab] = useState<LeadTab>('all')
  const [view, setView] = useState<DeskView>(phone.openMissedId ? 'missed' : 'today')
  const missedView = view === 'missed'
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
  const [scheduling, setScheduling] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [help, setHelp] = useState(false)
  /** The desk menu on a phone (the rail collapses into a top bar there). */
  const [navOpen, setNavOpen] = useState(false)
  const detailRef = useRef<HTMLElement>(null)
  /** The desk root, where the phone's bottom sheets mount. */
  const [sheetHost, setSheetHost] = useState<HTMLDivElement | null>(null)
  /** The last ended call whose result is in (or that the rep left for later). */
  const [wrappedSeq, setWrappedSeq] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const callRef = useRef<HTMLSpanElement>(null)
  const clock = useDeskClock(renderedAt ? Date.parse(renderedAt) : 0)
  const leads = draft && draft.source === initialLeads ? draft.leads : (initialLeads ?? seedLeads())

  function replace(next: CallLead) {
    // Functional: power mode replaces leads from async steps.
    setDraft((prev) => {
      const base = prev && prev.source === initialLeads ? prev.leads : (initialLeads ?? seedLeads())
      return { source: initialLeads, leads: base.map((lead) => (lead.id === next.id ? next : lead)) }
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

  // ── Today ────────────────────────────────────────────────────────────────
  const deskRep = leads.some((lead) => lead.persisted) ? (viewerId ?? '') : CURRENT_REP
  const board = todayBoard(visibleLeads(leads, 'all', language, query), new Date(clock), deskRep)

  // ── Wrap-up: the last call to a lead in this tab still owes a result ─────
  const last = voice?.lastCall ?? null
  const wrapLeadId = last ? leadIdOfTarget(last.target) : null
  const wrapLead = wrapLeadId ? (leads.find((lead) => lead.id === wrapLeadId) ?? null) : null
  // A result saved since the call started (here or in another tab) settles it.
  const resulted = Boolean(
    last && wrapLead?.trail.some((event) => event.kind === 'outcome' && Date.parse(event.at) >= last.endedAt - last.talkSeconds * 1000 - 120_000),
  )
  const wrapPending = Boolean(
    last && wrapLead && wrapLead.persisted && !wrapLead.dnc && last.seq > wrappedSeq && !resulted && canRecordOutcome(wrapLead, repFor(wrapLead)),
  )

  async function takeForPower(lead: CallLead): Promise<string | null> {
    if (lead.lockedBy && lead.lockedBy === viewerId) return null
    const result = await takeCallCenterLead(lead.id)
    if (!result.ok) return result.error
    replace(result.lead)
    return null
  }

  async function releaseForPower(lead: CallLead): Promise<void> {
    const result = await skipCallCenterLead(lead.id)
    if (result.ok) replace(result.lead)
    router.refresh()
  }

  const power = usePowerMode({
    voice,
    ranked: board.ranked,
    lastLeadId: wrapLeadId,
    wrapPending,
    take: takeForPower,
    release: releaseForPower,
    select: (lead) => openLead(lead),
  })

  const rows = visibleLeads(leads, tab, language, query)
  const pool = view === 'today' ? leads : rows
  const selected = pool.find((lead) => lead.id === selectedId && !lead.disabled) ?? null
  const who = selected ? repFor(selected) : CURRENT_REP
  const quietBlocked = Boolean(selected && now && callNeedsConfirm(selected, now) && callAnywayId !== selected.id)
  const revealLeadId = selected?.persisted && viewerId && selected.lockedBy === viewerId && !selected.dnc
    ? selected.id
    : null
  const dialPhone = revealLeadId && dial?.leadId === revealLeadId ? dial.phone : null
  const dialEmail = revealLeadId && dial?.leadId === revealLeadId ? dial.email : null
  // Power mode: no new dial until the last call has its result.
  const resultOwed = power.on && wrapPending

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

  // On a phone the selected lead is a full-screen panel: start it at the top
  // and keep the page behind it from scrolling.
  const panelOpen = Boolean(selected)
  useEffect(() => {
    if (!panelOpen || !onPhone()) return
    detailRef.current?.scrollTo({ top: 0 })
    const root = document.documentElement
    const before = root.style.overflow
    root.style.overflow = 'hidden'
    return () => {
      root.style.overflow = before
    }
  }, [panelOpen, selectedId])

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

  /** Callback without a time opens the scheduler; every other result saves now. */
  async function recordOutcome(lead: CallLead, outcome: LeadOutcome, callbackAt?: string): Promise<boolean> {
    if (outcome === 'callback' && !callbackAt) {
      setScheduling(lead.id)
      return false
    }
    setBusy(true)
    try {
      const ok = await commit(
        lead,
        () => saveCallCenterOutcome(lead.id, outcome, callbackAt ?? null),
        () => replace(applyOutcome(lead, outcome, stamp(), CURRENT_REP, { callbackAt })),
      )
      if (ok) {
        setScheduling(null)
        if (wrapPending && last && wrapLead?.id === lead.id) {
          setWrappedSeq(last.seq)
          power.afterWrapUp()
        }
      }
      return ok
    } finally {
      setBusy(false)
    }
  }

  function scheduler(lead: CallLead) {
    const picker = (
      <CallbackScheduler
        key={lead.id}
        name={lead.name}
        zone={lead.timeZone}
        now={clock || Date.parse(now ?? '') || 0}
        busy={busy}
        onSave={(at) => { void recordOutcome(lead, 'callback', at) }}
        onCancel={() => setScheduling(null)}
      />
    )
    // On a phone it is a bottom sheet. The lead panel is its own stacking
    // layer under the call bar, so the sheet mounts at the desk root to sit
    // above both. It only ever opens after a tap, so this never runs on the server.
    return sheetHost && onPhone() ? createPortal(picker, sheetHost) : picker
  }

  /** J/K walk the list on screen: the Today ranking then its queues, or the open tab's rows. */
  function step(dir: 1 | -1) {
    const order: CallLead[] = []
    const seen = new Set<string>()
    const add = (lead: CallLead) => {
      if (lead.disabled || seen.has(lead.id)) return
      seen.add(lead.id)
      order.push(lead)
    }
    if (view === 'today') {
      board.ranked.forEach((row) => add(row.lead))
      for (const items of Object.values(board.queues)) items.forEach((item) => add(item.lead))
    } else {
      rows.forEach(add)
    }
    if (!order.length) return
    const index = order.findIndex((lead) => lead.id === selectedId)
    const next = index === -1 ? order[dir === 1 ? 0 : order.length - 1] : order[(index + dir + order.length) % order.length]
    openLead(next)
  }

  useDeskKeys((action: DeskKeyAction) => {
    switch (action.kind) {
      case 'help':
        setHelp((open) => !open)
        return true
      case 'close':
        if (help) setHelp(false)
        else if (scheduling) setScheduling(null)
        else if (navOpen) setNavOpen(false)
        else if (selected && onPhone()) setSelectedId(null)
        else return false
        return true
      case 'search':
        searchRef.current?.focus()
        return true
      case 'next':
        step(1)
        return true
      case 'prev':
        step(-1)
        return true
      case 'call': {
        // Press the lead's own Call button: the same server check, every time.
        const button = callRef.current?.querySelector('button')
        if (button && !button.disabled) button.click()
        return Boolean(button)
      }
      case 'take':
        if (selected && canTake(selected, who)) {
          void commit(selected, () => takeCallCenterLead(selected.id), () => replace(takeLead(selected, CURRENT_REP, stamp())))
        }
        return Boolean(selected)
      case 'outcome': {
        const target = wrapPending ? wrapLead : selected
        const item = OUTCOMES[action.index]
        if (!target || !item || busy || !canRecordOutcome(target, repFor(target)) || !holding(target)) return false
        void recordOutcome(target, item.id)
        return true
      }
      case 'note':
        noteRef.current?.focus()
        return Boolean(noteRef.current)
      case 'power':
        if (!voice) return false
        power.toggle()
        return true
      case 'pause':
        if (power.phase !== 'countdown') return false
        power.pause()
        return true
    }
  })

  const refresh = useCallback(() => router.refresh(), [router])
  useLiveRefresh(refresh, () => {
    if (busy || scheduling || power.phase === 'dialing') return false
    return !voice || (voice.status === 'idle' && !voice.activeTarget && !voice.incoming)
  })

  return (
    <div
      ref={setSheetHost}
      className={[
        'final-desk call-center',
        navOpen ? 'nav-open' : '',
        power.on ? 'power-on' : '',
        selected ? 'detail-open' : '',
      ].filter(Boolean).join(' ')}
    >
      <div className="shell">
        <aside className="rail">
          <div className="brand">
            <small>SCS operations</small>
            <strong>Prodigy<span className="flo">Flo</span></strong>
          </div>
          {/* Shown below lg by the final-desk shell styles; opens the same links in a sheet. */}
          <button
            type="button"
            className="rail-toggle"
            aria-expanded={navOpen}
            aria-controls="call-center-nav"
            aria-label={navOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setNavOpen((open) => !open)}
          >
            <span aria-hidden="true">{navOpen ? '✕' : '☰'}</span>
            <span className="rail-toggle-label">Menu</span>
          </button>
          <nav className="nav" id="call-center-nav" aria-label="Desk">
            {RAIL.map((item) =>
              item.href === '/call-center' ? (
                <Link key={item.href} href={item.href} className="here" aria-current="page" onClick={() => setNavOpen(false)}>{item.label}</Link>
              ) : (
                <Link key={item.href} href={item.href} onClick={() => setNavOpen(false)}>{item.label}</Link>
              ),
            )}
          </nav>
        </aside>
        <div className="col">
          <header className="top">
            <label className="search">
              <span className="sr">Search leads</span>
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search leads"
                aria-label="Search leads"
              />
            </label>
            <div className="top-right">
              <label className="lang">
                <span className="lang-text">Working language</span>
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
              <button
                type="button"
                className={`power-toggle${power.on ? ' on' : ''}`}
                aria-pressed={power.on}
                disabled={!voice}
                title={voice ? 'Dial the next lead by itself after each result (P)' : 'Power mode needs browser calling.'}
                onClick={power.toggle}
              >
                Power mode {power.on ? 'on' : 'off'}
              </button>
              <button type="button" className="keys-btn" aria-label="Keyboard shortcuts" onClick={() => setHelp(true)}>?</button>
              <span className="voice" role="note">
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
            <PowerBar power={power} nameOf={(id) => leads.find((lead) => lead.id === id)?.name ?? null} />
            {wrapPending && wrapLead && last ? (
              <WrapUp
                lead={wrapLead}
                call={last}
                required={power.on}
                busy={busy}
                error={deskError}
                scheduler={scheduling === wrapLead.id ? scheduler(wrapLead) : null}
                onOutcome={(outcome) => { void recordOutcome(wrapLead, outcome) }}
                onLater={() => setWrappedSeq(last.seq)}
              />
            ) : null}
            <div className="filters" role="tablist" aria-label="Lead filters">
              <button
                type="button"
                role="tab"
                aria-selected={view === 'today'}
                className={view === 'today' ? 'on' : ''}
                onClick={() => setView('today')}
              >
                Today
              </button>
              {TABS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={view === 'list' && tab === item.id}
                  className={view === 'list' && tab === item.id ? 'on' : ''}
                  onClick={() => {
                    setView('list')
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
                onClick={() => setView('missed')}
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
              {view === 'today' ? (
                <TodayView board={board} rep={repFor} selectedId={selectedId} onOpen={openLead} />
              ) : (
              <div className="card lead-table">
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
                        <td className="c-when" data-label="When">{formatWhen(lead.arrivedAt)}</td>
                        <td className="c-person"><Person lead={lead} rep={repFor(lead)} onOpen={openLead} /></td>
                        <td className="c-chan" data-label="Came in as">{channelLabel(lead.channel)}</td>
                        <td className={`c-contacted ${lead.contacted ? 'yes' : 'no'}`} data-label="Contacted">{lead.contacted ? 'Yes' : 'No'}</td>
                        <td className="c-status" data-label="Status">{lead.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!rows.length && <p className="block muted">No leads in this view.</p>}
              </div>
              )}
              <article
                ref={detailRef}
                className={`card block detail${selected ? ' open' : ''}`}
                aria-label={selected ? `Lead: ${selected.name}` : undefined}
              >
                {selected ? (
                  <>
                    <div className="detail-bar">
                      <button type="button" className="detail-back" onClick={() => setSelectedId(null)}>
                        <span aria-hidden="true">‹</span> {view === 'today' ? 'Today' : 'Leads'}
                      </button>
                      <span className="detail-bar-name">{selected.name}</span>
                    </div>
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
                    {isExhausted(selected) ? (
                      <div className="banner" role="status">No further tries. Close it with Not interested or Wrong number.</div>
                    ) : null}
                    {selected.missedCallId ? (
                      <div className="banner" role="status">
                        <button
                          type="button"
                          className="linkish"
                          onClick={() => {
                            setOpenMissedId(selected.missedCallId ?? null)
                            setView('missed')
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
                    <div className="actions trio">
                      <button type="button" className="btn secondary" disabled={!canTake(selected, who)} onClick={() => { void commit(selected, () => takeCallCenterLead(selected.id), () => replace(takeLead(selected, CURRENT_REP, stamp()))) }}>Take</button>
                      <button type="button" className="btn secondary" onClick={() => { void skipSelected() }}>Skip</button>
                      <button type="button" className="btn secondary" onClick={jump}>Next</button>
                    </div>
                    <h3>Contact</h3>
                    <div className="actions duo">
                      <span ref={callRef} className="call-slot">
                        {selected.persisted ? (
                          <CallButton
                            key={selected.id}
                            appearance="desk"
                            target={{ kind: 'lead', id: selected.id }}
                            tel={dialPhone}
                            who={selected.name}
                            canOverrideHours={phone.canOverrideHours}
                            disabled={!canCall(selected, who) || !holding(selected) || resultOwed}
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
                      </span>
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={!canText(selected, who) || !holding(selected)}
                        onClick={() => { void commit(selected, () => recordCallCenterText(selected.id), () => replace(applyLeadAction(selected, 'text', stamp()))) }}
                      >
                        Text
                      </button>
                    </div>
                    {resultOwed ? <p className="muted">Pick a result for the last call first.</p> : null}
                    {selected.persisted ? <p className="muted">Texting leads isn&rsquo;t live yet.</p> : null}
                    {now && textHeldUntilMorning(selected, now) ? <p className="muted">{HELD_UNTIL_MORNING}</p> : null}
                    <h3>Result</h3>
                    {scheduling === selected.id && !(wrapPending && wrapLead?.id === selected.id) ? (
                      scheduler(selected)
                    ) : (
                      <div className="actions outcomes">
                        {OUTCOMES.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className="btn secondary"
                            disabled={busy || !canRecordOutcome(selected, who) || !holding(selected)}
                            onClick={() => { void recordOutcome(selected, item.id) }}
                          >
                            {item.label}
                          </button>
                        ))}
                      </div>
                    )}
                    <h3>Handoff</h3>
                    <div className="actions solo">
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
                      ref={noteRef}
                      className="note"
                      value={note}
                      placeholder="Note on this attempt"
                      aria-label="Note on this attempt"
                      disabled={!canSaveNote(selected, who) || !holding(selected)}
                      onChange={(event) => setNote(event.target.value)}
                    />
                    <div className="actions solo">
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
                          {event.recording?.transcript ? (
                            <blockquote className="muted transcript">&ldquo;{event.recording.transcript}&rdquo;</blockquote>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  </>
                ) : (
                  <>
                    <h2 className="who">Select a lead</h2>
                    <p className="muted">
                      {view === 'today'
                        ? 'Pick someone from Call first or a queue. Press ? for keyboard shortcuts.'
                        : 'Click a row. The Spanish page placeholder stays disabled.'}
                    </p>
                  </>
                )}
              </article>
            </div>
            )}
          </main>
        </div>
      </div>
      {help ? (
        <div className="keys-sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={() => setHelp(false)}>
          <div className="card block" onClick={(event) => event.stopPropagation()}>
            <h3>Keyboard shortcuts</h3>
            <p className="muted">They work anywhere on the desk except while you are typing.</p>
            <dl>
              {SHORTCUTS.map((row) => (
                <div key={row.keys}>
                  <dt><kbd>{row.keys}</kbd></dt>
                  <dd>{row.what}</dd>
                </div>
              ))}
            </dl>
            <div className="actions">
              <button type="button" className="btn secondary" onClick={() => setHelp(false)}>Close</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
