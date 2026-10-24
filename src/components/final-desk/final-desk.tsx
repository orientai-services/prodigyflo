'use client'

import { SunoffPill } from '@/components/call-center/sunoff-pill'
import { leadHref } from '@/lib/call-center/lead-link'

import { Children, cloneElement, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Menu, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { signOut } from 'next-auth/react'
import { assignDeskCloserAction, bookAppointmentAction, markNoShowAction } from '@/app/(app)/board/actions'
import { approveBriefAction, editBriefAction } from '@/app/(app)/clients/[clientId]/closeops-actions'
import { setUserActiveAction } from '@/app/(app)/settings/users/actions'
import { decideFinalSuggestion, inviteFinalCloser, saveFinalQuestionnaire } from '@/lib/final-desk/actions'
import { QUESTION_SECTIONS, answerCount, type QuestionnaireAnswers } from '@/lib/final-desk/questions'
import { DOCUMENT_MODULES } from '@/lib/final-desk/mapping'
import { boardForMonth, civilDate, parseMonth, shiftIso, shiftMonth, timeLabel, todayAction, weekCovered, weekDayIsos, weekTitle, zonedDate, type DeskChip } from '@/lib/daily-desk'
import type { CaseDocTile } from '@/lib/daily-desk-case-types'
import type { DeskView, FinalDeskPayload } from '@/lib/final-desk/types'
import { DocumentQuicklook } from './document-quicklook'
import { CloserBriefSection, DocumentsSection, FinanceSection, IntakeSection, LeadSourceSection, QuestionnaireProgress, RedlineSection, SolarSection, UPLOAD_ACCEPT, uploadDocumentFile } from './profile-sections'
import { UnscheduledList } from './unscheduled-list'
import { ClientFilterPanel } from './client-filter-panel'
import { LocaleSwitch, useUiLocale } from '@/components/locale-switch'
import { DialerModeSwitch } from '@/components/call-center/dialer-mode-switch'
import { InstallAppEntry } from '@/components/pwa/install-app'
import { UI_COPY } from '@/lib/ui-copy'
import { uiCopyFor } from '@/lib/ui-copy.es'
import { parseClientFilter, type ClientFilter, type ClientQuery } from '@/lib/final-desk/filters'
import type { SchedulingResult } from '@/lib/scheduling'
import './final-desk.css'

const paths: Record<string, string> = { board: '/board', clients: '/clients', queue: '/queue', engine: '/engine', documents: '/documents', submissions: '/submissions', users: '/settings/users' }
const fmt = (iso: string, tz: string) => new Date(iso).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })
const countDocs = (docs: { key: string }[]) => new Set(docs.filter(d => DOCUMENT_MODULES.some(([key]) => key === d.key)).map(d => d.key)).size
const mins = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5))

/** Each cell carries its column heading as data-label, so phones can show rows as labelled cards (final-desk.css). */
function Table({ headings, children }: { headings: string[]; children: ReactNode }) {
  const rows = Children.map(children, (row) => isValidElement<{ children?: ReactNode }>(row)
    ? cloneElement(row, undefined, Children.map(row.props.children, (cell, i) => isValidElement(cell) && headings[i] ? cloneElement(cell as ReactElement<Record<string, unknown>>, { 'data-label': headings[i] }) : cell))
    : row)
  return <table><thead><tr>{headings.map((h, i) => <th key={i}>{h}</th>)}</tr></thead><tbody>{rows}</tbody></table>
}

/** React implementation of the supplied HTML; no sample clients or client-side authorization. */
export function FinalDesk({ initial, view, clientId, query = {} }: { initial: FinalDeskPayload; view: DeskView; clientId?: string; query?: ClientQuery }) {
  const locale = useUiLocale()
  const t = uiCopyFor(locale, UI_COPY)
  const router = useRouter(), [data, setData] = useState(initial), [toast, setToast] = useState(''), [busy, setBusy] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const [now, setNow] = useState<Date | null>(null), [mode, setMode] = useState<'month' | 'week' | 'day'>('month')
  // Board sides: 'scs' is intake (no advisor or no booked date, with source pills), 'booked' is the calendar.
  // Admins land on intake, closers on their calendar; a manual pick sticks per device.
  const [side, setSide] = useState<'scs' | 'booked'>(() => {
    const fallback = initial.user.role === 'SUPER_ADMIN' ? 'scs' : 'booked'
    if (typeof window === 'undefined') return fallback
    try { const saved = localStorage.getItem('desk_side'); return saved === 'scs' || saved === 'booked' ? saved : fallback } catch { return fallback }
  })
  function pickSide(next: 'scs' | 'booked') { setSide(next); try { localStorage.setItem('desk_side', next) } catch {} }
  const [day, setDay] = useState(initial.board?.today ?? ''), [cursor, setCursor] = useState(initial.board?.today ?? ''), [modal, setModal] = useState<'assign' | 'book' | null>(null)
  const [target, setTarget] = useState<{ id: string; appointmentId?: string; expectedUpdatedAt?: string }>({ id: clientId ?? '' })
  const [closer, setCloser] = useState(''), [note, setNote] = useState(''), [bookDate, setBookDate] = useState(initial.file?.bookDate ?? initial.board?.today ?? ''), [bookTime, setBookTime] = useState(initial.file?.bookTime ?? '10:00')
  const [look, setLook] = useState<CaseDocTile | null>(null), [menu, setMenu] = useState<{ x: number; y: number; chip: DeskChip } | null>(null)
  const [answers, setAnswers] = useState<QuestionnaireAnswers>(initial.questionnaire?.answers ?? {}), [page, setPage] = useState(initial.questionnaire?.page ?? 0)
  const answerRef = useRef(answers), touched = useRef(new Set<string>()), revision = useRef(initial.questionnaire?.revision ?? 0), saving = useRef<Promise<boolean> | null>(null)
  const calendarRef = useRef<HTMLDivElement>(null), busyRef = useRef(false), refreshEpoch = useRef(0), bookingRequest = useRef('')
  const cursorRef = useRef(initial.board?.today ?? '')
  const file = data.file, board = data.board, clients = data.clients ?? [], isAdmin = data.user.role === 'SUPER_ADMIN'
  const monthRef = useRef(board?.month)
  const tz = board?.timezone ?? file?.timezone ?? 'America/Los_Angeles'
  const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const closers = board?.closers ?? file?.closers ?? []
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function notify(message: string) { setToast(message); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 6000) }
  function rememberMonth(key: string) {
    monthRef.current = key
    const url = new URL(window.location.href)
    if (url.searchParams.get('month') === key) return
    url.searchParams.set('month', key)
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
  }
  function showLoadedMonth(key: string) {
    setData((prev) => (prev.board && prev.board.month !== key ? { ...prev, board: boardForMonth(prev.board, key) } : prev))
  }
  async function refresh(month?: string) {
    const requested = month ?? monthRef.current
    const epoch = ++refreshEpoch.current
    const params = new URLSearchParams({ view, ...query, ...(clientId ? { clientId } : {}), ...(requested ? { month: requested } : {}) })
    const response = await fetch(`/api/desk?${params}`, { cache: 'no-store' })
    if (!response.ok) { if ([401, 403, 404].includes(response.status)) router.refresh(); throw Error('Unable to refresh this view') }
    const next: FinalDeskPayload = await response.json()
    // The 15s poll can still be answering for the previous month. Applying it snaps the arrows back.
    if (epoch !== refreshEpoch.current) return
    if (next.board && monthRef.current && next.board.month !== monthRef.current) return
    setData(next)
    if (next.board?.month) monthRef.current = next.board.month
    if (next.questionnaire && !touched.current.size && !saving.current) { answerRef.current = next.questionnaire.answers; setAnswers(next.questionnaire.answers); revision.current = next.questionnaire.revision }
  }
  useEffect(() => {
    if (!navOpen) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setNavOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navOpen])
  useEffect(() => { monthRef.current = board?.month }, [board?.month])
  useEffect(() => { cursorRef.current = cursor }, [cursor])
  useEffect(() => { const tick = () => setNow(new Date()); const timer = setInterval(tick, 15000); tick(); return () => { clearInterval(timer); if (toastTimer.current) clearTimeout(toastTimer.current) } }, [])
  useEffect(() => {
    const timer = setInterval(() => {
      if (!busyRef.current && view !== 'questionnaire') void refresh().catch(() => {})
    }, 15000)
    return () => clearInterval(timer)
  }, [view])
  function applyBooking(result: SchedulingResult) {
    if (!result.appointmentId || !result.startsAt || !result.clientId) return
    setData(previous => {
      const b = previous.board
      if (!b) return previous
      const lead = b.unscheduled.find(c => c.clientId === result.clientId)
      const existing = b.days.flatMap(d => d.chips).find(c => c.appointmentId === result.appointmentId)
      const source = existing ?? lead
      const appointment: DeskChip | null = source ? { ...source, appointmentId: result.appointmentId!, startsAt: result.startsAt!, status: result.status ?? 'SCHEDULED', updatedAt: result.updatedAt, timeLabel: timeLabel(new Date(result.startsAt!), b.timezone) } : null
      const active = ['SCHEDULED', 'CONFIRMED'].includes(result.status ?? '') && new Date(result.endsAt ?? 0) > new Date()
      return { ...previous, board: { ...b,
        unscheduled: active ? b.unscheduled.filter(c => c.clientId !== result.clientId) : b.unscheduled,
        unscheduledTotal: Math.max(0, b.unscheduledTotal - (active && lead ? 1 : 0)),
        days: b.days.map(d => ({ ...d, chips: [...d.chips.filter(c => c.appointmentId !== result.appointmentId), ...(appointment && civilDate(new Date(result.startsAt!), b.timezone) === d.iso ? [appointment] : [])] })),
      } }
    })
  }
  async function run(fn: () => Promise<{ ok?: boolean; error?: string; message?: string; appointment?: SchedulingResult }>, success: string) {
    if (busyRef.current) return
    busyRef.current = true; ++refreshEpoch.current; setBusy(true)
    try {
      const result = await fn()
      if (result.error || result.ok === false) throw Error(result.error || 'Action failed')
      ++refreshEpoch.current
      if (result.appointment) applyBooking(result.appointment)
      notify(result.message || success); setModal(null)
      try { await refresh() } catch { notify(`${success}. The view could not refresh; retry shortly.`) }
    } catch (e) { notify(e instanceof Error ? e.message : 'Action failed') }
    finally { busyRef.current = false; setBusy(false) }
  }
  function applyFilters(filter: ClientFilter, scheduling?: string, pageNumber = 1) {
    try {
      parseClientFilter(JSON.stringify(filter), data.clientList?.fields ?? [])
      const params = new URLSearchParams()
      if (filter.groups.length) params.set('filters', JSON.stringify(filter))
      if (scheduling) params.set('scheduling', scheduling)
      if (pageNumber > 1) params.set('page', String(pageNumber))
      router.push(`/clients${params.size ? '?' + params : ''}`)
    } catch (e) { notify(e instanceof Error ? e.message : 'Invalid filters') }
  }
  const open = (id: string) => router.push(`/clients/${encodeURIComponent(id)}`)
  const go = async (next: string) => { setNavOpen(false); if (view !== 'questionnaire' || await flush()) router.push(paths[next]) }
  function openModal(kind: 'assign' | 'book', id = file?.id ?? '', appointmentId = file?.appointmentId ?? undefined, expectedUpdatedAt = file?.appointmentUpdatedAt ?? undefined) {
    bookingRequest.current = crypto.randomUUID(); setTarget({ id, appointmentId, expectedUpdatedAt }); setCloser(closers[0]?.id ?? ''); setNote(''); setBookDate(file?.bookDate ?? (day || board?.today || '')); setBookTime(file?.bookTime ?? '10:00'); setModal(kind)
  }
  async function draftRequest(tile?: CaseDocTile) {
    const labels = tile ? [tile.label] : file?.docs.filter(d => d.state === 'missing').map(d => d.label) ?? []
    notify(`Doc request drafted for ${file?.firstName ?? 'client'}: ${labels.join(', ') || 'none missing'}`)
  }
  async function copyContact(chip?: DeskChip) {
    const contact = chip ? `${chip.firstName} ${chip.lastName} · ${chip.phone} · ${chip.email}` : `${file?.firstName} ${file?.lastName} · ${answers.phone ?? ''} · ${answers.email ?? ''}`
    try { await navigator.clipboard.writeText(contact); notify(`Copied ${chip ? chip.firstName : file?.firstName} contact details`) } catch { notify('Clipboard permission is unavailable') }
  }
  async function upload(tile: CaseDocTile) {
    const input = document.createElement('input'); input.type = 'file'; input.accept = UPLOAD_ACCEPT
    input.onchange = () => { const selected = input.files?.[0]; if (!selected || !file) return
      void run(() => uploadDocumentFile(file.id, tile, selected), 'Document uploaded') }
    input.click()
  }
  function changeAnswer(key: string, value: string | string[]) { touched.current.add(key); answerRef.current = { ...answerRef.current, [key]: value }; setAnswers(answerRef.current) }
  async function flush(nextPage = page, complete = false): Promise<boolean> {
    while (saving.current) { if (!await saving.current) return false }
    const snapshot = { ...answerRef.current }, dirty = [...touched.current]
    const task = (async () => {
      try {
      const result = await saveFinalQuestionnaire({ clientId, answers: snapshot, touched: dirty, page: nextPage, revision: revision.current, complete })
      if (!result.ok) { notify(result.error || 'Draft could not be saved'); return false }
      revision.current = result.revision!; for (const key of dirty) if (JSON.stringify(answerRef.current[key]) === JSON.stringify(snapshot[key])) touched.current.delete(key)
      return true
      } catch { notify('Draft could not be saved. Your changes are still on this page.'); return false }
    })()
    saving.current = task
    try { return await task } finally { if (saving.current === task) saving.current = null }
  }
  async function moveQuestionnaire(next: number, complete = false) { setBusy(true); try { if (await flush(next, complete)) { if (complete) open(clientId!); else { setPage(next); notify('Draft saved') } } } finally { setBusy(false) } }
  async function selectDay(next: string) {
    setDay(next); setCursor(next); cursorRef.current = next; setMode('day')
    const nextKey = parseMonth(next.slice(0, 7)).key
    if (monthRef.current === nextKey) return
    rememberMonth(nextKey); showLoadedMonth(nextKey)
    try { await refresh(nextKey) } catch { notify('Could not load appointments for that day.') }
  }
  function shiftDay(delta: number) { void selectDay(shiftIso(day, delta)) }
  function showMonth(key: string) {
    const nextKey = parseMonth(key).key
    setMode('month')
    // The ref can still say "this month" after the grid has moved. Trust the grid.
    if (monthRef.current === nextKey && board?.month === nextKey) return
    rememberMonth(nextKey); showLoadedMonth(nextKey)
    void refresh(nextKey).catch(() => notify('Could not load appointments for that month.'))
  }
  function showWeek(iso: string) {
    cursorRef.current = iso; setCursor(iso); setMode('week')
    if (board && weekCovered(iso, board.days.map(d => d.iso))) return
    const nextKey = parseMonth(iso.slice(0, 7)).key
    if (monthRef.current !== nextKey) { rememberMonth(nextKey); showLoadedMonth(nextKey) }
    void refresh(nextKey).catch(() => notify('Could not load appointments for that week.'))
  }
  function openWeek() {
    if (!board) return
    const loaded = board.days.map(d => d.iso)
    const anchor = cursor && weekCovered(cursor, loaded) ? cursor : (board.days.find(d => d.inMonth)?.iso ?? board.today)
    void showWeek(anchor)
  }
  async function jumpToday(kind: 'month' | 'week') {
    const iso = now ? civilDate(now, tz) : (board?.today ?? '')
    if (!iso || !board) return
    const action = todayAction(kind, board.month, cursorRef.current || cursor, iso, board.days.map(d => d.iso))
    cursorRef.current = iso
    setCursor(iso)
    if (action === 'day') { await selectDay(iso); return }
    if (action === 'move-week') showWeek(iso)
    else showMonth(iso.slice(0, 7))
  }
  function drop(event: React.DragEvent, date: string, time = '10:00') {
    event.preventDefault()
    const id = event.dataTransfer.getData('text/plain')
    if (!id || !board?.canBook || busyRef.current || !board.unscheduled.some(c => c.clientId === id)) return
    if (zonedDate(date, time, tz) <= new Date()) {
      openModal('book', id); setBookDate(date); setBookTime(''); notify('Choose an appointment time in the future.'); return
    }
    const requestId = crypto.randomUUID()
    void run(() => bookAppointmentAction({ clientId: id, date, time, requestId }), 'Appointment saved')
  }
  const liveChips = board?.days.flatMap(d => d.chips).filter(c => ['SCHEDULED', 'CONFIRMED'].includes(c.status)) ?? []
  const soon = now ? liveChips.filter(c => new Date(c.startsAt).getTime() > now.getTime() && new Date(c.startsAt).getTime() - now.getTime() <= 1800000).sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0] : null
  const unscheduled = board && <UnscheduledList board={board} calendarRef={calendarRef} dayMode={mode === 'day'} busy={busy} open={open} viewAll={() => router.push('/clients?scheduling=unscheduled')} />
  function chip(c: DeskChip, agenda = false) { const top = ((mins(timeLabel(new Date(c.startsAt), tz)) - 480) / 60) * 64 + 4
    return <div key={c.appointmentId} className={`${agenda ? 'appt' : 'chip'}${c.ownerName ? '' : ' u'}`} style={agenda ? { top, height: 56 } : undefined} onClick={e => { e.stopPropagation(); if (c.sourceLeadId) router.push(leadHref(c.sourceLeadId)); else open(c.clientId) }} onContextMenu={e => { e.preventDefault(); if (c.sourceLeadId) { router.push(leadHref(c.sourceLeadId)); return }; setMenu({ x: e.clientX, y: e.clientY, chip: c }) }}><span className="chip-time">🕐 {fmt(c.startsAt, tz)}</span><b>{c.firstName} {c.lastName} {c.sourceBrand ? <SunoffPill /> : null}</b><span className="closer">{c.ownerName ? `Closer - ${c.ownerName}` : 'Unassigned'}</span></div>
  }
  let content: ReactNode = null
  if (view === 'board' && board) {
    const dayChips = liveChips.filter(c => civilDate(new Date(c.startsAt), tz) === day)
    const today = now ? civilDate(now, tz) : board.today
    const dateLocale = locale === 'es' ? 'es-US' : 'en-US'
    const dayTitle = day ? new Date(`${day}T12:00:00Z`).toLocaleDateString(dateLocale, { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : ''
    const focus = cursor || today
    const periodNav = (kind: 'month' | 'week' | 'day') => {
      const prevLabel = kind === 'month' ? t.prevMonth : kind === 'week' ? t.prevWeek : t.prevDay
      const nextLabel = kind === 'month' ? t.nextMonth : kind === 'week' ? t.nextWeek : t.nextDay
      const onPrev = kind === 'month' ? () => void showMonth(shiftMonth(monthRef.current || board.month, -1)) : kind === 'week' ? () => void showWeek(shiftIso(cursorRef.current || focus, -7)) : () => shiftDay(-1)
      const onNext = kind === 'month' ? () => void showMonth(shiftMonth(monthRef.current || board.month, 1)) : kind === 'week' ? () => void showWeek(shiftIso(cursorRef.current || focus, 7)) : () => shiftDay(1)
      return <>
        {kind !== 'day' && <div className="seg" role="group" aria-label={t.calendarView}><button type="button" className={kind === 'month' ? 'on' : ''} onClick={() => kind === 'week' && void showMonth(board.month)}>{t.month}</button><button type="button" className={kind === 'week' ? 'on' : ''} onClick={() => kind === 'month' && openWeek()}>{t.weekView}</button></div>}
        <button type="button" className="btn secondary" aria-label={prevLabel} onClick={onPrev}>←</button>
        <button type="button" className="btn secondary" onClick={() => kind === 'day' ? void selectDay(today) : void jumpToday(kind)}>{t.today}</button>
        <button type="button" className="btn secondary" aria-label={nextLabel} onClick={onNext}>→</button>
        {kind === 'day' && <><button type="button" className="btn secondary" onClick={() => void showWeek(day || today)}>{t.weekView}</button><button type="button" className="btn" onClick={() => { setCursor(day || today); setMode('month') }}>{t.month}</button></>}
      </>
    }
    const monthBoard = <><div className="banner" role="button" tabIndex={0} style={{ cursor: 'pointer' }} title="Open SCS intake" onClick={() => pickSide('scs')} onKeyDown={e => e.key === 'Enter' && pickSide('scs')}>{board.unassignedCount} unassigned leads. Click here for SCS intake · click a day for the hour view.</div><div className="grid board-grid"><div className="card" ref={calendarRef}><div className="head"><h2>{board.title}</h2><div className="actions">{periodNav('month')}</div></div><div className="week">{t.week.map(w => <span key={w}>{w}</span>)}</div><div className="days">{board.days.map(d => <div key={d.iso} className={`day${d.inMonth ? '' : ' mute'}${d.iso === today ? ' today' : ''}`} onClick={() => d.inMonth && void selectDay(d.iso)} onDragOver={e => e.preventDefault()} onDrop={e => d.inMonth && drop(e, d.iso)}>{d.inMonth && <><span className="num">{d.day}</span><small className="dow" aria-hidden="true">{t.week[new Date(`${d.iso}T12:00:00Z`).getUTCDay()]}</small>{d.chips.filter(c => ['SCHEDULED','CONFIRMED'].includes(c.status)).map(c => chip(c))}</>}</div>)}</div></div>{unscheduled}</div></>
    const weekBoard = <><div className="banner">{t.weekBanner}</div><div className="grid board-grid"><div className="card" ref={calendarRef}><div className="head"><h2>{weekTitle(focus, dateLocale)}</h2><div className="actions">{periodNav('week')}</div></div><div className="week-board">{weekDayIsos(focus).map(iso => { const cell = board.days.find(d => d.iso === iso); return <div key={iso} className={`wcol${iso === today ? ' today' : ''}`} onClick={() => void selectDay(iso)} onDragOver={e => e.preventDefault()} onDrop={e => drop(e, iso)}><div className="wlabel">{t.week[new Date(`${iso}T12:00:00Z`).getUTCDay()]}</div><span className="num">{Number(iso.slice(8))}</span>{cell?.chips.filter(c => ['SCHEDULED','CONFIRMED'].includes(c.status)).map(c => chip(c))}</div> })}</div></div>{unscheduled}</div></>
    const dayBoard = <><div className="banner">{dayChips.length ? `${dayChips.length} appointment${dayChips.length === 1 ? '' : 's'} this day. Click a block to open the file.` : 'No appointments this day. Drag someone from Unscheduled onto an hour.'}</div><div className="grid board-grid"><div className="card" ref={calendarRef}><div className="head"><h2>{dayTitle}</h2><div className="actions">{periodNav('day')}</div></div><div className="agenda" style={{ padding: '0 0 18px' }}><div>{Array.from({ length: 12 }, (_, i) => <div className="agenda-hour" key={i}>{i + 8 < 12 ? `${i + 8} AM` : `${(i + 8) % 12 || 12} PM`}</div>)}</div><div className="agenda-track" style={{ minHeight: 768 }}>{Array.from({ length: 12 }, (_, i) => <div key={i} className="agenda-slot" onDragOver={e => e.preventDefault()} onDrop={e => drop(e, day, `${String(i + 8).padStart(2,'0')}:00`)} />)}{dayChips.map(c => chip(c, true))}{now && day === today && mins(timeLabel(now, tz)) >= 480 && mins(timeLabel(now, tz)) <= 1200 && <div className="nowline" style={{ top: (mins(timeLabel(now, tz)) - 480) / 60 * 64 }} />}</div></div>{!dayChips.length && <div className="empty-day">Nothing booked for {dayTitle}.</div>}</div>{unscheduled}</div></>
    const srcPill = (c: { sourceBrand?: 'SunOff'; sourceName?: string | null }) =>
      c.sourceBrand ? <SunoffPill /> : <span className="tag">{c.sourceName ?? 'Unknown'}</span>
    const bookedUnassigned = liveChips.filter(c => !c.ownerName && !board.unscheduled.some(u => u.clientId === c.clientId))
    const intakeRows = [
      ...board.unscheduled.map(c => ({ key: `u:${c.clientId}`, c, why: c.ownerName ? t.noDateBooked : t.noAdvisor, when: null as string | null })),
      ...bookedUnassigned.map(c => ({ key: `a:${c.appointmentId}`, c, why: t.bookedNoAdvisor, when: `${civilDate(new Date(c.startsAt), tz)} · ${fmt(c.startsAt, tz)}` })),
    ]
    const scsBoard = <><div className="banner">{t.intakeBanner}</div><div className="card"><div className="head"><h2>{t.intakeTitle}</h2><div className="actions"><span className="muted">{board.unscheduledTotal} {t.noDateBooked.toLowerCase()} · {bookedUnassigned.length} {t.bookedNoAdvisor.toLowerCase()}</span></div></div>
      <Table headings={['Name', 'Source', 'Status', 'Docs', '']}>{intakeRows.map(({ key, c, why, when }) => <tr className="row" key={key} onClick={() => open(c.clientId)}><td><b>{c.firstName} {c.lastName}</b></td><td>{srcPill(c)}</td><td><span className={`tag ${c.ownerName ? '' : 'w'}`}>{why}</span>{when ? <span className="muted"> {when}</span> : null}</td><td>{c.missingDocs ? `${c.missingDocs} missing` : 'On file'}</td><td onClick={e => e.stopPropagation()}><span className="actions">{board.canAssign && !c.ownerName && <button className="btn secondary" disabled={busy} onClick={() => openModal('assign', c.clientId, 'appointmentId' in c ? (c as DeskChip).appointmentId : undefined)}>Assign</button>}{board.canBook && !when && <button className="btn secondary" disabled={busy} onClick={() => openModal('book', c.clientId)}>Book</button>}</span></td></tr>)}</Table>
      {!intakeRows.length && <p className="block muted">{t.intakeEmpty}</p>}
      {board.unscheduledTotal > board.unscheduled.length && <div className="head"><span className="muted">{board.unscheduled.length} of {board.unscheduledTotal} shown</span><button className="btn secondary" onClick={() => router.push('/clients?scheduling=unscheduled')}>{t.viewAll}</button></div>}
    </div></>
    const sideRow = <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}><div className="seg" role="group" aria-label="SCS / Booked"><button type="button" className={side === 'scs' ? 'on' : ''} onClick={() => pickSide('scs')}>SCS</button><button type="button" className={side === 'booked' ? 'on' : ''} onClick={() => pickSide('booked')}>{t.bookedSide}</button></div></div>
    content = <>{sideRow}{side === 'scs' ? scsBoard : mode === 'week' ? weekBoard : mode === 'day' ? dayBoard : monthBoard}</>
  } else if (view === 'profile' && file) {
    const q = data.questionnaire!, progress = answerCount(q.answers)
    content = <><article className="card ph"><div><button className="btn secondary" onClick={() => go('board')}>← Board</button><div className="who">{String(q.answers.legal_name || `${file.firstName} ${file.lastName}`)}</div><div className="muted">{file.city}, {file.state} {file.zip} · {file.source} · {file.stage}</div><div className="muted">{file.phone && <a href={`tel:${file.phone.replace(/\D/g, '').length === 10 ? `+1${file.phone.replace(/\D/g, '')}` : file.phone}`}>📞 {file.phone}</a>}{file.phone && file.email ? ' · ' : ''}{file.email && <a href={`mailto:${file.email}`}>✉️ {file.email}</a>}</div><div className="tags"><span className={`tag ${file.ownerName ? 'g' : 'w'}`}>Owner: {file.ownerName || 'Unassigned'}</span><span className="tag">{file.appointmentLabel ? `Appt ${file.appointmentLabel}` : 'Not booked'}</span><span className="tag">Docs {file.docsPresent}/8</span><span className={`tag ${file.extractionLabel === 'verified' ? 'g' : 'w'}`}>Extraction {file.extractionLabel}</span><span className={`tag ${file.creditOnFile ? 'g' : 'w'}`}>{file.creditOnFile ? `Credit ${file.creditLabel}` : 'Credit not on file'}</span>{file.outOfArea && <span className="tag w" data-testid="out-of-area">Out of area</span>}</div></div><div className="actions"><button className="btn" onClick={() => router.push(`/clients/${file.id}/questionnaire`)}>{t.editDetails}</button>{file.canAssign && <button className="btn" onClick={() => openModal('assign')}>Assign closer</button>}<button className="btn secondary" disabled={!file.canBook} onClick={() => openModal('book')}>{file.appointmentLabel ? 'Reschedule' : 'Book'}</button><button className="btn secondary" onClick={() => void draftRequest()}>Request missing docs</button><button className="btn secondary" onClick={() => void copyContact()}>Call</button></div></article>{!!file.leadAttribution?.length && <LeadSourceSection rows={file.leadAttribution} />}<div className="g2"><FinanceSection cells={file.finance} /><SolarSection cells={file.solar} /></div><DocumentsSection docs={file.docs} canUpload={file.canUpload} busy={busy} onLook={setLook} onUpload={(d) => void upload(d)} /><div className="g2"><IntakeSection intake={file.intake}><QuestionnaireProgress done={q.done} progress={progress} onOpen={() => router.push(`/clients/${file.id}/questionnaire`)} /></IntakeSection><RedlineSection state={file.state} redline={file.redline} /></div><CloserBriefSection file={file} busy={busy} onApprove={() => void run(() => approveBriefAction({ clientId: file.id, briefId: file.brief!.id }), 'Brief approved')} onEdit={() => { const body = window.prompt('Edit closer brief', file.brief!.body); if (body?.trim()) void run(() => editBriefAction({ clientId: file.id, briefId: file.brief!.id, body }), 'Brief updated · needs approve') }} /></>
  } else if (view === 'questionnaire' && file) {
    const section = QUESTION_SECTIONS[page], progress = answerCount(answers)
    content = <div className="card block"><div className="head" style={{ padding: '0 0 8px' }}><div><button className="btn secondary" disabled={busy} onClick={async () => { if (await flush()) open(file.id) }}>← Back to {file.firstName}&apos;s file</button><h2 style={{ marginTop: 12 }}>{section.t}</h2><div className="muted">Section {page + 1} of 9 · {progress} of 42 answered</div></div></div><div className="qbar"><i style={{ width: `${Math.round(progress / 42 * 100)}%` }} /></div>{section.qs.map(q => <div className="qfield" key={q.id}><label htmlFor={`q-${q.id}`}>{q.l}</label>{q.ty === 'text' || q.ty === 'long' ? q.ty === 'long' ? <textarea id={`q-${q.id}`} rows={4} value={String(answers[q.id] ?? '')} disabled={busy} onChange={e => changeAnswer(q.id, e.target.value)} onBlur={() => void flush()} /> : <input id={`q-${q.id}`} value={String(answers[q.id] ?? '')} disabled={busy} onChange={e => changeAnswer(q.id, e.target.value)} onBlur={() => void flush()} /> : <div className="qgrid">{q.o?.map(o => { const value = answers[q.id], on = Array.isArray(value) ? value.includes(o) : value === o; return <button className={`qopt${on ? ' on' : ''}`} aria-pressed={on} disabled={busy} type="button" key={o} onClick={() => { if (q.ty === 'multi') { const old = Array.isArray(value) ? value : []; const next = on ? old.filter(v => v !== o) : /^(None|No hardship)/.test(o) ? [o] : [...old.filter(v => !/^(None|No hardship)/.test(v)), o]; changeAnswer(q.id, next) } else changeAnswer(q.id, o); void flush() }}>{o}</button> })}</div>}</div>)}<div className="qfoot">{page === 0 ? <span /> : <button className="btn secondary" disabled={busy} onClick={() => void moveQuestionnaire(page - 1)}>Back</button>}{page < 8 ? <button className="btn" disabled={busy} onClick={() => void moveQuestionnaire(page + 1)}>Next</button> : <button className="btn" disabled={busy || progress < 42} style={progress < 42 ? { opacity: .45 } : undefined} onClick={() => void moveQuestionnaire(page, true)}>Complete</button>}</div>{page === 8 && progress < 42 && <p className="muted" style={{ marginTop: 10 }}>Complete stays locked until all 42 have an answer. {42 - progress} still blank.</p>}</div>
  } else if (view === 'clients') {
    const listing = data.clientList
    content = <div className="card"><div className="head"><h2>All files</h2><div className="actions"><span className="muted">{listing?.total ?? clients.length} matching{process.env.NEXT_PUBLIC_PREVIEW_MODE === 'true' ? ' · isolated preview' : ''}</span>{listing && <ClientFilterPanel fields={listing.fields} current={listing.filters} scheduling={listing.scheduling} onApply={applyFilters} />}</div></div><Table headings={['Name','State','Stage','Owner','Appointment','Docs','Credit']}>{clients.map(c => <tr className="row" key={c.id} onClick={() => open(c.id)}><td><b>{c.name}</b></td><td>{c.state} {c.zip}</td><td>{c.stage}</td><td>{c.owner || 'Unassigned'}</td><td>{c.appointment || '—'}</td><td>{countDocs(c.docs)}/8</td><td>{c.credit ?? 'Not on file'}</td></tr>)}</Table>{!clients.length && <p className="block muted">No clients match these filters.</p>}{listing && <div className="head client-pages"><button className="btn secondary" disabled={listing.page <= 1} onClick={() => applyFilters(listing.filters, listing.scheduling, listing.page - 1)}>Previous</button><span>Page {listing.page} of {Math.max(1, Math.ceil(listing.total / listing.pageSize))}</span><button className="btn secondary" disabled={listing.page * listing.pageSize >= listing.total} onClick={() => applyFilters(listing.filters, listing.scheduling, listing.page + 1)}>Next</button></div>}</div>
  } else if (view === 'queue') {
    content = <div className="card"><div className="head"><h2>Needs a human</h2></div><Table headings={['Client','Why','']}>{clients.filter(c => c.extraction === 'unverified' || (c.extraction === 'none' && c.appointment)).map(c => <tr className="row" key={c.id} onClick={() => open(c.id)}><td>{c.name}</td><td>{c.extraction === 'unverified' ? 'Extraction unverified — confirm finance fields' : 'Booked with no contract on file'}</td><td>Open profile</td></tr>)}</Table></div>
  } else if (view === 'engine') {
    content = <><div className="banner">Suggestions only. Accept writes nothing to the homeowner site.</div>{data.suggestions?.map(e => <div key={e.id} className="card block" style={{ marginBottom: 12 }}><h3>{e.state === 'open' ? 'Open' : e.state}</h3><p style={{ fontSize: 16, fontWeight: 600, margin: '6px 0' }}>{e.title}</p><p className="muted">{e.body}</p><div className="actions" style={{ marginTop: 12 }}><button className="btn" onClick={() => open(e.clientId)}>Open {e.name.split(' ')[0]}</button><button className="btn secondary" disabled={busy} onClick={() => void run(() => decideFinalSuggestion({ id: e.id, decision: 'accepted' }), 'Suggestion accepted')}>Accept</button><button className="btn secondary" disabled={busy} onClick={() => void run(() => decideFinalSuggestion({ id: e.id, decision: 'dismissed' }), 'Suggestion dismissed')}>Dismiss</button></div></div>)}</>
  } else if (view === 'documents') {
    content = <div className="card"><div className="head"><h2>Uploaded files</h2><span className="muted">Click a row to open the case</span></div><Table headings={['Client','Document','State','Extraction']}>{clients.flatMap(c => c.docs.map(d => <tr key={d.id} className="row" onClick={() => open(c.id)}><td>{c.name}</td><td>{d.label}</td><td>{d.state}</td><td>{c.extraction}</td></tr>))}</Table></div>
  } else if (view === 'submissions') {
    content = <><div className="banner">Nothing leaves this desk until a human marks the file ready. No live CYS push in the prototype.</div><div className="g2">{[true, false].map(ready => <div className="card" key={String(ready)}><div className="head"><h2>{ready ? 'Ready' : 'Blocked'}</h2></div><Table headings={['Client','State','']}>{clients.filter(c => (c.extraction === 'verified') === ready).map(c => <tr className="row" key={c.id} onClick={() => open(c.id)}><td>{c.name}</td><td>{c.state}</td><td>{ready ? 'Finance verified · packet incomplete' : c.extraction === 'none' ? 'No agreement' : 'Unverified extraction'}</td></tr>)}</Table></div>)}</div></>
  } else if (view === 'users') {
    content = <div className="card"><div className="head"><h2>Invite only</h2><button className="btn" disabled={busy} onClick={() => { const email = window.prompt('Email to invite'); if (email?.trim()) void run(() => inviteFinalCloser({ email: email.trim() }), 'Invitation sent') }}>Invite teammate</button></div><Table headings={['Name','Role','Email','Status','']}>{data.staff?.map(u => <tr key={u.id}><td><b>{u.name}</b></td><td>{u.role}</td><td>{u.email}</td><td>{u.status}</td><td>{u.inviteId ? <button className="btn secondary" disabled={busy} onClick={() => void run(() => inviteFinalCloser({ inviteId: u.inviteId }), 'Invitation resent')}>Resend invite</button> : <button className="btn secondary" disabled={busy} onClick={() => void run(async () => { const f = new FormData(); f.set('userId', u.id); f.set('active', String(u.status === 'Disabled')); const r = await setUserActiveAction({}, f); return { ok: !r.error, ...r } }, u.status === 'Disabled' ? 'User enabled' : 'User disabled')}>Disable</button>}</td></tr>)}</Table></div>
  }
  return <div className={`final-desk${navOpen ? ' nav-open' : ''}`} onClick={() => menu && setMenu(null)}><div className="shell"><aside className="rail"><div className="brand"><small>SCS operations</small><strong>ProdigyFlo</strong></div><button type="button" className="rail-toggle" aria-expanded={navOpen} aria-controls="final-desk-nav" aria-label={navOpen ? 'Close menu' : t.openMenu} onClick={() => setNavOpen(v => !v)}>{navOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}</button><nav className="nav" id="final-desk-nav" aria-label="Desk"><DialerModeSwitch on={false} />{['board','clients','queue'].map(v => <button key={v} className={view === v ? 'on' : ''} onClick={() => go(v)}>{v === 'queue' ? `${t.titles.queue} · ${data.queueCount}` : t.titles[v as DeskView]}</button>)}<div className="sec">{t.nav.more}</div>{['engine','documents','submissions','users'].filter(v => isAdmin || !['engine','users'].includes(v)).map(v => <button key={v} className={view === v ? 'on' : ''} onClick={() => go(v)}>{t.titles[v as DeskView]}</button>)}</nav><div className="rail-foot"><b>{data.user.name}</b>{isAdmin ? 'Super Admin' : 'Closer'}<br />{t.inviteOnly}<br /><InstallAppEntry variant="rail" /><button className="out" onClick={() => void signOut({ callbackUrl: '/login' })}>{t.signOut}</button></div></aside><div className="col"><header className="top"><div><h1>{t.titles[view]}</h1><div className="muted">{now ? `${now.toLocaleDateString(locale === 'es' ? 'es-US' : 'en-US', { timeZone: viewerTz, weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })} · 🕐 ${now.toLocaleTimeString(locale === 'es' ? 'es-US' : 'en-US', { timeZone: viewerTz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}` : ''}</div></div><div className="top-tools" style={{ display: 'flex', alignItems: 'center', gap: 12 }}><LocaleSwitch className="max-lg:h-11 max-lg:px-1 max-lg:[&>button]:h-full max-lg:[&>button]:min-w-9 max-lg:[&>button]:text-xs" /><div className={`alarm${soon ? ' hot' : ''}`}><span className="bell">⏰</span><span>{soon && now ? `${soon.firstName} ${soon.lastName} · in ${Math.max(1, Math.ceil((new Date(soon.startsAt).getTime() - now.getTime()) / 60000))} min` : 'No call in the next 30 min'}</span></div><div className="muted disclaimer">Not a law firm · review only</div></div></header><main className="main">{content}</main></div></div>
    {modal && <div className="modal on"><div className="box"><h3>{modal === 'assign' ? 'Assign closer' : 'Book / reschedule'}</h3>{modal === 'assign' ? <><select aria-label="Closer" value={closer} onChange={e => setCloser(e.target.value)}>{closers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><textarea aria-label="Optional note" placeholder="Optional note" rows={3} value={note} onChange={e => setNote(e.target.value)} /></> : <><input aria-label="Appointment date" type="date" value={bookDate} onChange={e => { bookingRequest.current = crypto.randomUUID(); setBookDate(e.target.value) }} /><input aria-label="Appointment time" type="time" value={bookTime} onChange={e => { bookingRequest.current = crypto.randomUUID(); setBookTime(e.target.value) }} /></>}<div className="actions"><button className="btn" disabled={busy || (modal === 'assign' ? !closer : !bookDate || !bookTime)} onClick={() => void run(() => modal === 'assign' ? assignDeskCloserAction({ clientId: target.id, closerId: closer, note }) : bookAppointmentAction({ clientId: target.id, appointmentId: target.appointmentId, expectedUpdatedAt: target.expectedUpdatedAt, requestId: bookingRequest.current, date: bookDate, time: bookTime }), modal === 'assign' ? 'Closer assigned' : 'Appointment saved')}>{modal === 'assign' ? 'Confirm' : 'Save'}</button><button className="btn secondary" disabled={busy} onClick={() => setModal(null)}>Cancel</button></div></div></div>}
    {look && <DocumentQuicklook key={look.key} tile={look} allFiles={file?.availableFiles ?? []} clientLabel={`${file?.firstName} ${file?.lastName} · ${file?.city}, ${file?.state} ${file?.zip}`} firstName={file?.firstName ?? ''} onClose={() => setLook(null)} onRequest={() => void draftRequest(look)} />}

    {menu && <div className="menu" style={{ display: 'block', left: menu.x, top: menu.y }}>{['View profile', ...(isAdmin ? ['Assign closer'] : []), 'Reschedule', 'Copy contact', 'Mark no-show'].map(label => <button key={label} onClick={() => { const c = menu.chip; if (label === 'View profile') open(c.clientId); else if (label === 'Assign closer') openModal('assign', c.clientId, c.appointmentId); else if (label === 'Reschedule') { openModal('book', c.clientId, c.appointmentId, c.updatedAt); setBookDate(civilDate(new Date(c.startsAt), tz)); setBookTime(timeLabel(new Date(c.startsAt), tz)) } else if (label === 'Copy contact') void copyContact(c); else void run(() => markNoShowAction({ clientId: c.clientId, appointmentId: c.appointmentId }), 'Appointment marked no-show') }}>{label}</button>)}</div>}
    {toast && <div className="toast" role="status" style={{ display: 'block' }}>{toast}</div>}
  </div>
}
