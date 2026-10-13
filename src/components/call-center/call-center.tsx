'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MessageSquare, Phone } from 'lucide-react'
import {
  recordCallCenterAttempt,
  recordCallCenterText,
  revealCallCenterContact,
  saveCallCenterNote,
  saveCallCenterOutcome,
  skipCallCenterLead,
  takeCallCenterLead,
} from '@/lib/call-center/actions'
import {
  LEAD_FILTERS,
  filterLeads,
  sectionHref,
  shellTitle,
  todayBadge,
  todayCounts,
  updatedLabel,
  badgeText,
  type DeskFilter,
  type ShellRoute,
} from '@/lib/call-center/app-shell'
import type { DeskResult } from '@/lib/call-center/desk-types'
import { leadIdOfTarget } from '@/lib/call-center/lead-link'
import { todayBoard } from '@/lib/call-center/priority'
import { SHORTCUTS, type DeskKeyAction } from '@/lib/call-center/shortcuts'
import type { TeamMember } from '@/lib/call-center/team'
import type { MissedCallVM, TwilioStatusVM } from '@/lib/telephony/voice-contract'
import type { PhoneSetupVM } from '@/lib/telephony/ui/phone-setup-data'
import { CallButton } from '@/components/voice/call-button'
import { useVoice } from '@/components/voice/voice-provider'
import { MissedCalls } from '@/components/telephony/missed-calls'
import { PhoneSetupSheet } from '@/components/telephony/phone-setup-sheet'
import {
  CURRENT_REP,
  HELD_UNTIL_MORNING,
  OUTCOMES,
  QUIET_BANNER,
  applyLeadAction,
  applyOutcome,
  badgeLabel,
  callNeedsConfirm,
  canCall,
  canRecordOutcome,
  canSaveNote,
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
  type IntakeMode,
  type LanguageFilter,
  type LeadOutcome,
} from '@/lib/call-center/model'
import { SectionNav } from './app-nav'
import { CallbackScheduler } from './callback-scheduler'
import { DialPad } from './dial-pad'
import { HandoffGroup, LeadProfile, useLeadHandoff } from './lead-profile'
import { MoreSheet } from './more-sheet'
import { PhoneStatusPill, usePhoneStatus } from './phone-pill'
import { BookVisit } from './calendar/scheduler'
import { PowerBar, WrapUp } from './power-panel'
import { ChoiceSelect } from './choice-select'
import { CommsTrail } from './comms-trail'
import { OUTCOME_PLACEHOLDER, outcomeGroups } from './outcome-choices'
import { TeamView } from './team-view'
import { TodayView, type TodayServer } from './today-view'
import { useDeskClock, useDeskKeys, useLiveRefresh } from './use-desk-effects'
import { usePowerMode } from './use-power-mode'
import { useChatHost } from './use-chat-host'
import { chatHref } from './messages/chat/host-bus'
import '../final-desk/final-desk.css'
import './call-center.css'

/** Below this width the lead opens as a full-screen panel instead of the split view. */
const PHONE_QUERY = '(max-width: 767.98px)'
/** Below this width the sections are a bottom tab bar and More is a bottom sheet. */
const TABBAR_QUERY = '(max-width: 1023.98px)'

function matches(query: string): boolean {
  return typeof window !== 'undefined' && window.matchMedia(query).matches
}

function onPhone(): boolean {
  return matches(PHONE_QUERY)
}

/** A desk action's lead doesn't read the Client link or the texting gate: keep what the desk had. */
function keepLinks(before: CallLead, next: CallLead): CallLead {
  return {
    ...next,
    clientId: next.clientId !== undefined ? next.clientId : before.clientId,
    intakeTextBlock: next.intakeTextBlock !== undefined ? next.intakeTextBlock : before.intakeTextBlock,
  }
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
  /** Why browser calling is off (plain English), or null when it is on. The phone pill's sheet shows it. */
  voiceNote?: string | null
  missed?: MissedCallVM[]
  /** `?missed=<id>`: open the Missed list on that row. */
  openMissedId?: string | null
  /** `?lead=<id>`: open that lead. */
  openLeadId?: string | null
  /** Holds telephony:manage; may stretch a narrowed calling window with a reason. */
  canOverrideHours?: boolean
  /** SUPER_ADMIN only: the Phone setup sheet. */
  setup?: { vm: PhoneSetupVM; status: TwilioStatusVM | null } | null
}

const TODAY_ROUTE: ShellRoute = { section: 'today', ads: false, filter: null }

/**
 * The dialer app (docs/DIALER_APP.md): a sticky header (section title, the
 * phone pill, the Dialer button), the six sections as a bottom tab bar on a
 * phone or a strip on a desk, and the open section. Today and Leads are
 * drawn here from the desk's leads; Messages, History, Booked, Campaigns and
 * Team arrive as server-rendered slots or data.
 */
export function CallCenter({
  initialLeads,
  viewerId,
  phone = {},
  renderedAt,
  route = TODAY_ROUTE,
  adsAllowed = false,
  calendarAllowed = false,
  slot = null,
  unread = 0,
  unreadSplit = null,
  today = null,
  team = null,
  viewer = null,
  threadOpen = false,
}: {
  initialLeads?: CallLead[]
  viewerId?: string
  phone?: CallCenterPhone
  /** The server's clock when it rendered, so the first Today ranking matches on both sides. */
  renderedAt?: string
  /** The open section, from `?s=` (and the old `?tab=` / `?lead=` / `?missed=` links). */
  route?: ShellRoute
  /** Holds connectors:read, so More shows Campaigns. */
  adsAllowed?: boolean
  /** CALL_CENTER_CALENDAR is on, so Booked shows the planner and leads offer Book visit. */
  calendarAllowed?: boolean
  /** The open section's server slot: History, Messages, the Ads dashboard or the calendar planner. */
  slot?: React.ReactNode
  /** Unread inbound texts (the Messages badge). */
  unread?: number
  /** The same badge split into lead texts and team chat, so the shell can keep each live (use-chat-host.ts); `cases` = case-chat unread per lead id. */
  unreadSplit?: { sms: number; team: number; cases?: Record<string, number> } | null
  /** Today's server numbers and team feed (Today only). */
  today?: TodayServer | null
  /** The team list (Team only). */
  team?: TeamMember[] | null
  viewer?: { name: string; role: string } | null
  /** A Messages thread fills the phone screen: the tab bar steps aside. */
  threadOpen?: boolean
}) {
  const router = useRouter()
  const voice = useVoice()
  const section = route.section
  // The Messages badge, the "(n) " title prefix, the open conversation's name and chat notification taps.
  const chatHost = useChatHost({ sms: unreadSplit?.sms ?? unread, team: unreadSplit?.team ?? 0, cases: unreadSplit?.cases, onMessages: section === 'messages' })
  const leadsList = section === 'leads' && !route.ads
  /** Today and Leads hold the lead panel, the tools and the shortcuts. */
  const deskSection = section === 'today' || leadsList
  const [draft, setDraft] = useState<{ source: CallLead[] | undefined; leads: CallLead[] } | null>(null)
  const [tab, setTab] = useState<DeskFilter>(route.filter ?? 'all')
  // Arriving on Leads (a tab, a Today tile, a Missed link) starts from the URL's filter, or All.
  // The chips themselves stay client-side, so the 20 s refresh keeps the one picked.
  const filterKey = `${section}|${route.filter ?? ''}`
  const [filterSeen, setFilterSeen] = useState(filterKey)
  if (filterKey !== filterSeen) {
    setFilterSeen(filterKey)
    setTab(route.filter ?? 'all')
  }
  const missedView = leadsList && tab === 'missed'
  const [language, setLanguage] = useState<LanguageFilter>('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(phone.openLeadId ?? null)
  /** Below 1024 the lead sheet has two tabs: the lead itself and the Client profile. */
  const [detailTab, setDetailTab] = useState<'lead' | 'profile'>('lead')
  const profileRef = useRef<HTMLElement>(null)
  // `?lead=` can change on this mounted screen (the Calendar's Open lead, a Messages link): open that lead.
  const [leadSeen, setLeadSeen] = useState(phone.openLeadId ?? null)
  if ((phone.openLeadId ?? null) !== leadSeen) {
    setLeadSeen(phone.openLeadId ?? null)
    if (phone.openLeadId) setSelectedId(phone.openLeadId)
  }
  const missed = phone.missed ?? []
  const [now, setNow] = useState<string | null>(null)
  const [callAnywayId, setCallAnywayId] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [dial, setDial] = useState<{ leadId: string; phone: string | null; email: string | null } | null>(null)
  const [deskError, setDeskError] = useState<string | null>(null)
  const [scheduling, setScheduling] = useState<string | null>(null)
  /** The lead whose Book visit scheduler is open. */
  const [booking, setBooking] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [help, setHelp] = useState(false)
  const [padOpen, setPadOpen] = useState(false)
  const padButtonRef = useRef<HTMLButtonElement>(null)
  /** The owner's Phone setup sheet (opened from the phone pill's sheet). */
  const [setupOpen, setSetupOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  // A section change (any tab, a More link) closes More.
  const routeKey = `${section}:${route.ads}`
  const [routeSeen, setRouteSeen] = useState(routeKey)
  if (routeKey !== routeSeen) {
    setRouteSeen(routeKey)
    setMoreOpen(false)
  }
  /** Holds the phone pill: More › Settings opens its sheet by pressing it. */
  const pillSlotRef = useRef<HTMLSpanElement>(null)
  /** The section bar: More's button lives in it. */
  const navRef = useRef<HTMLElement>(null)
  const phoneStatus = usePhoneStatus(phone.voiceNote)
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
      return { source: initialLeads, leads: base.map((lead) => (lead.id === next.id ? keepLinks(lead, next) : lead)) }
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
  const clockDate = new Date(clock)
  const board = todayBoard(visibleLeads(leads, 'all', language, ''), clockDate, deskRep)
  const counts = todayCounts(leads, clockDate)

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

  const rows = filterLeads(leads, tab, language, query, clockDate)
  const pool = section === 'today' ? leads : rows
  const selected = deskSection && !missedView
    ? (pool.find((lead) => lead.id === selectedId && !lead.disabled) ?? null)
    : null
  const who = selected ? repFor(selected) : CURRENT_REP
  const quietBlocked = Boolean(selected && now && callNeedsConfirm(selected, now) && callAnywayId !== selected.id)
  const revealLeadId = selected?.persisted && viewerId && selected.lockedBy === viewerId && !selected.dnc
    ? selected.id
    : null
  const handoff = useLeadHandoff({
    lead: selected,
    rep: who,
    holds: selected ? holding(selected) : false,
    admin: viewer?.role === 'SUPER_ADMIN',
    now: clock,
    onChanged: () => router.refresh(),
    onPreview: (lead: CallLead, mode: IntakeMode) => {
      const at = stamp()
      replace({ ...sendIntakeLink(lead, at), intake: { sentAt: at, mode } })
    },
  })
  function openProfile() {
    setDetailTab('profile')
    if (!matches(TABBAR_QUERY)) profileRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }
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
    setDetailTab('lead')
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

  /** J/K walk the list on screen: the Today ranking, or the open filter's rows. */
  function step(dir: 1 | -1) {
    const order: CallLead[] = []
    const seen = new Set<string>()
    const add = (lead: CallLead) => {
      if (lead.disabled || seen.has(lead.id)) return
      seen.add(lead.id)
      order.push(lead)
    }
    if (section === 'today') board.ranked.forEach((row) => add(row.lead))
    else rows.forEach(add)
    if (!order.length) return
    const index = order.findIndex((lead) => lead.id === selectedId)
    const next = index === -1 ? order[dir === 1 ? 0 : order.length - 1] : order[(index + dir + order.length) % order.length]
    openLead(next)
  }

  useDeskKeys((action: DeskKeyAction) => {
    if (action.kind === 'close') {
      if (padOpen) setPadOpen(false)
      else if (moreOpen) setMoreOpen(false)
      else if (help) setHelp(false)
      else if (booking) setBooking(null)
      else if (scheduling) setScheduling(null)
      else if (selected && onPhone()) setSelectedId(null)
      else return false
      return true
    }
    // Shortcuts belong to the lead lists: off on Messages, Booked, History, Team, Campaigns and Missed.
    if (!deskSection || missedView) return false
    switch (action.kind) {
      case 'help':
        setHelp((open) => !open)
        return true
      case 'search':
        if (!leadsList) return false
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

  function dialPad() {
    const pad = (
      <DialPad
        canOverrideHours={phone.canOverrideHours}
        disabled={resultOwed}
        ignore={padButtonRef}
        onClose={() => setPadOpen(false)}
      />
    )
    // Like the scheduler: a bottom sheet at the desk root on a phone, a popover under the button on a desk.
    return sheetHost && onPhone() ? createPortal(pad, sheetHost) : pad
  }

  const line = voice?.setup.lines.find((l) => l.id === voice.lineId) ?? voice?.setup.lines[0] ?? null
  function moreSheet() {
    const sheet = (
      <MoreSheet
        adsAllowed={adsAllowed}
        phone={phoneStatus}
        line={line ? (line.label && line.label !== line.display ? `${line.label} · ${line.display}` : line.display) : null}
        updated={updatedLabel(renderedAt ? Date.parse(renderedAt) : clock, clock)}
        viewer={viewer}
        toggle={navRef}
        onClose={() => setMoreOpen(false)}
        onSettings={() => {
          setPadOpen(false)
          // The pill owns its sheet; pressing it is the one way in, from anywhere.
          pillSlotRef.current?.querySelector<HTMLButtonElement>('.phone-pill')?.click()
        }}
      />
    )
    // A bottom sheet over the tab bar below 1024, a popover under More on a desk.
    return sheetHost && matches(TABBAR_QUERY) ? createPortal(sheet, sheetHost) : sheet
  }

  const refresh = useCallback(() => router.refresh(), [router])
  useLiveRefresh(refresh, () => {
    if (busy || scheduling || booking || power.phase === 'dialing') return false
    return !voice || (voice.status === 'idle' && !voice.activeTarget && !voice.incoming)
  })

  return (
    <div
      ref={setSheetHost}
      className={[
        'final-desk call-center',
        `s-${section}`,
        power.on ? 'power-on' : '',
        selected ? 'detail-open' : '',
        threadOpen ? 'thread-open' : 'tabs-on',
      ].filter(Boolean).join(' ')}
    >
      <header className="cc-head">
        <Link href={sectionHref('today')} className="cc-mark" aria-label="ProdigyFlo dialer, Today">
          <span className="cc-word">Prodigy<span className="flo">Flo</span></span>
          <span className="cc-glyph" aria-hidden="true">P</span>
        </Link>
        <h1 className="cc-title">
          {chatHost.chatTitle ? (
            <>
              {/* Below 1024 px the open conversation names the page, like the SunOff dialer's top bar. */}
              <span className="cc-title-desk">{shellTitle(route)}</span>
              <span className="cc-title-chat">{chatHost.chatTitle}</span>
            </>
          ) : (
            shellTitle(route)
          )}
        </h1>
        <div className="cc-head-right">
          {/* The phone's state at a glance; its sheet holds the settings and the test. */}
          <span ref={pillSlotRef} className="phone-anchor">
            <PhoneStatusPill voiceNote={phone.voiceNote} onOpenSetup={phone.setup ? () => setSetupOpen(true) : undefined} />
          </span>
          <span className="pad-anchor">
            <button
              ref={padButtonRef}
              type="button"
              className={`cc-dialer${padOpen ? ' on' : ''}`}
              aria-haspopup="dialog"
              aria-expanded={padOpen}
              title="Call any US number by hand"
              onClick={() => {
                setMoreOpen(false)
                setPadOpen((open) => !open)
              }}
            >
              <Phone aria-hidden="true" />
              <span>Dialer</span>
            </button>
            {padOpen ? dialPad() : null}
          </span>
          {phone.setup ? (
            // Opened from the phone sheet; the sheet's own trigger stays out of the header.
            <PhoneSetupSheet
              setup={phone.setup.vm}
              status={phone.setup.status}
              triggerClassName="cc-hidden"
              open={setupOpen}
              onOpenChange={setSetupOpen}
            />
          ) : null}
        </div>
      </header>
      <SectionNav
        route={route}
        badges={{ today: todayBadge(counts), messages: chatHost.total }}
        moreOpen={moreOpen}
        onMore={() => {
          setPadOpen(false)
          setMoreOpen((open) => !open)
        }}
        more={moreOpen ? moreSheet() : null}
        navRef={navRef}
      />
      <main className="main cc-main">
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
        {deskSection ? (
          <div className="cc-tools">
            {leadsList ? (
              <label className="search">
                <span className="sr">Search leads</span>
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search leads"
                  aria-label="Search leads"
                />
              </label>
            ) : null}
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
          </div>
        ) : null}
        {leadsList ? (
          <div className="filters" role="tablist" aria-label="Lead filters">
            {LEAD_FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                className={tab === item.id ? 'on' : ''}
                onClick={() => setTab(item.id)}
              >
                {item.label}
                {item.id === 'missed' && missed.length ? ` (${missed.length})` : ''}
              </button>
            ))}
          </div>
        ) : null}
        {route.ads ? (
          <>
            <Link className="back-link" href={sectionHref('leads')}><span aria-hidden="true">‹</span> Leads</Link>
            <div className="ads-panel">{slot}</div>
          </>
        ) : section === 'booked' ? (
          slot ?? (
            <div className="card block">
              <h3>Booked</h3>
              <p className="muted">The visit calendar isn&rsquo;t switched on for this workspace yet.</p>
            </div>
          )
        ) : section === 'team' ? (
          <TeamView members={team ?? []} />
        ) : !deskSection ? (
          slot
        ) : missedView ? (
          <div className="card">
            <MissedCalls calls={missed} openId={phone.openMissedId ?? null} canOverrideHours={phone.canOverrideHours} />
          </div>
        ) : (
            <div className={`split${selected ? ' profile-on' : ''}`}>
              {section === 'today' ? (
                <TodayView
                  board={board}
                  counts={counts}
                  now={clock}
                  server={today}
                  rep={repFor}
                  selectedId={selectedId}
                  canOverrideHours={phone.canOverrideHours}
                  resultOwed={resultOwed}
                  onOpen={openLead}
                  onTelDialed={(lead) => { void commit(lead, () => recordCallCenterAttempt(lead.id), () => {}) }}
                />
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
                className={`card block detail${selected ? ` open has-profile tab-${detailTab}` : ''}`}
                aria-label={selected ? `Lead: ${selected.name}` : undefined}
              >
                {selected ? (
                  <>
                    <div className="detail-bar">
                      <button type="button" className="detail-back" onClick={() => setSelectedId(null)}>
                        <span aria-hidden="true">‹</span> {section === 'today' ? 'Today' : 'Leads'}
                      </button>
                      <span className="detail-bar-name">{selected.name}</span>
                    </div>
                    <div className="detail-tabs" role="tablist" aria-label="Lead panel">
                      <button type="button" role="tab" aria-selected={detailTab === 'lead'} className={detailTab === 'lead' ? 'on' : ''} onClick={() => setDetailTab('lead')}>Lead</button>
                      <button type="button" role="tab" aria-selected={detailTab === 'profile'} className={detailTab === 'profile' ? 'on' : ''} onClick={() => setDetailTab('profile')}>Profile</button>
                    </div>
                    <div className="detail-cols">
                    <div className="lead-main">
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
                        <Link
                          className="linkish"
                          href={`/call-center?s=leads&missed=${encodeURIComponent(selected.missedCallId)}`}
                          onClick={() => setSelectedId(null)}
                        >
                          Missed call waiting. Open it.
                        </Link>
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
                        <ChoiceSelect
                          groups={outcomeGroups()}
                          placeholder={OUTCOME_PLACEHOLDER}
                          label={`Result for ${selected.name}`}
                          disabled={busy || !canRecordOutcome(selected, who) || !holding(selected)}
                          onChoose={(outcome) => { void recordOutcome(selected, outcome) }}
                        />
                        {calendarAllowed && selected.persisted ? (
                          <button
                            type="button"
                            className="btn secondary"
                            disabled={selected.dnc}
                            onClick={() => setBooking(selected.id)}
                          >
                            Book visit
                          </button>
                        ) : null}
                      </div>
                    )}
                    {booking === selected.id && sheetHost
                      ? createPortal(
                          <BookVisit
                            key={selected.id}
                            lead={{ id: selected.id, name: selected.name }}
                            onClose={() => setBooking(null)}
                            onSaved={refresh}
                          />,
                          sheetHost,
                        )
                      : null}
                    <h3>Handoff</h3>
                    <HandoffGroup api={handoff} onOpenProfile={openProfile} />
                    {selected.persisted ? (
                      <div className="actions solo">
                        {/* The lead's case chat in Team chat (docs/TEAM_CHAT_PARITY.md A4); Messages finds it by lead id. */}
                        <Link className="btn secondary cc-teamchat" href={chatHref({ lead: selected.id })} scroll={false}>
                          <MessageSquare aria-hidden="true" />
                          Team chat
                          {chatHost.cases[selected.id] ? (
                            <>
                              <span className="cc-badge" aria-hidden="true">{badgeText(chatHost.cases[selected.id])}</span>
                              <span className="sr">{`, ${chatHost.cases[selected.id]} unread`}</span>
                            </>
                          ) : null}
                        </Link>
                      </div>
                    ) : null}
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
                    <CommsTrail key={selected.id} trail={selected.trail} />
                    </div>
                    <aside ref={profileRef} className="lead-profile-col" aria-label="Client profile">
                      <LeadProfile api={handoff} now={clock} sheetHost={sheetHost} />
                    </aside>
                    </div>
                  </>
                ) : (
                  <>
                    <h2 className="who">Select a lead</h2>
                    <p className="muted">
                      {section === 'today'
                        ? 'Pick someone from What to attack first. Press ? for keyboard shortcuts.'
                        : 'Click a row. The Spanish page placeholder stays disabled.'}
                    </p>
                  </>
                )}
              </article>
            </div>
        )}
      </main>
      {help ? (
        <div className="keys-sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={() => setHelp(false)}>
          <div className="card block" onClick={(event) => event.stopPropagation()}>
            <h3>Keyboard shortcuts</h3>
            <p className="muted">They work on Today and Leads except while you are typing.</p>
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
