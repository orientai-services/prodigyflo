'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { signOut } from 'next-auth/react'
import { assignDeskCloserAction, bookAppointmentAction, markNoShowAction } from '@/app/(app)/board/actions'
import { approveBriefAction, editBriefAction } from '@/app/(app)/clients/[clientId]/closeops-actions'
import { setUserActiveAction } from '@/app/(app)/settings/users/actions'
import { decideFinalSuggestion, inviteFinalCloser, saveFinalQuestionnaire } from '@/lib/final-desk/actions'
import { QUESTION_SECTIONS, answerCount, type QuestionnaireAnswers } from '@/lib/final-desk/questions'
import { DOCUMENT_MODULES } from '@/lib/final-desk/mapping'
import { civilDate, timeLabel, zonedDate, type DeskChip } from '@/lib/daily-desk'
import type { CaseCell, CaseDocTile } from '@/lib/daily-desk-case-types'
import type { DeskView, FinalDeskPayload } from '@/lib/final-desk/types'
import { PdfPreview } from '@/components/client/pdf-preview'
import { UnscheduledList } from './unscheduled-list'
import { ClientFilterPanel } from './client-filter-panel'
import { parseClientFilter, type ClientFilter, type ClientQuery } from '@/lib/final-desk/filters'
import type { SchedulingResult } from '@/lib/scheduling'
import './final-desk.css'

const paths: Record<string, string> = { board: '/board', clients: '/clients', queue: '/queue', engine: '/engine', documents: '/documents', submissions: '/submissions', users: '/settings/users' }
const titles: Record<DeskView, string> = { board: 'Master Calendar Board', clients: 'Clients', profile: 'Client profile', questionnaire: 'Questionnaire', queue: 'Queue', engine: 'Engine', documents: 'Document lab', submissions: 'CYS / submissions', users: 'Users' }
const fmt = (iso: string, tz: string) => new Date(iso).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })
const countDocs = (docs: { key: string }[]) => new Set(docs.filter(d => DOCUMENT_MODULES.some(([key]) => key === d.key)).map(d => d.key)).size
const mins = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5))

function Cell({ value }: { value: CaseCell }) {
  const c = value.cell
  return <div className="cell"><label>{value.label}</label><div className={`v${c.kind === 'value' ? '' : ' m'}`}>
    {c.kind === 'value' ? c.display : c.kind === 'cannot_compute' ? 'Cannot compute' : 'Missing'}
  </div>{(value.hint || value.unverified || c.kind === 'cannot_compute') && <small>{[value.unverified ? 'Unverified' : '', value.hint, c.kind === 'cannot_compute' ? `Needs ${c.missing.join(', ')}` : ''].filter(Boolean).join(' · ')}</small>}</div>
}
function Table({ headings, children }: { headings: string[]; children: ReactNode }) {
  return <table><thead><tr>{headings.map((h, i) => <th key={i}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table>
}

/** React implementation of the supplied HTML; no sample clients or client-side authorization. */
export function FinalDesk({ initial, view, clientId, query = {} }: { initial: FinalDeskPayload; view: DeskView; clientId?: string; query?: ClientQuery }) {
  const router = useRouter(), [data, setData] = useState(initial), [toast, setToast] = useState(''), [busy, setBusy] = useState(false)
  const [now, setNow] = useState<Date | null>(null), [mode, setMode] = useState<'month' | 'day'>('month')
  const [day, setDay] = useState(initial.board?.today ?? ''), [modal, setModal] = useState<'assign' | 'book' | null>(null)
  const [target, setTarget] = useState<{ id: string; appointmentId?: string; expectedUpdatedAt?: string }>({ id: clientId ?? '' })
  const [closer, setCloser] = useState(''), [note, setNote] = useState(''), [bookDate, setBookDate] = useState(initial.file?.bookDate ?? initial.board?.today ?? ''), [bookTime, setBookTime] = useState(initial.file?.bookTime ?? '10:00')
  const [look, setLook] = useState<CaseDocTile | null>(null), [menu, setMenu] = useState<{ x: number; y: number; chip: DeskChip } | null>(null)
  const [answers, setAnswers] = useState<QuestionnaireAnswers>(initial.questionnaire?.answers ?? {}), [page, setPage] = useState(initial.questionnaire?.page ?? 0)
  const answerRef = useRef(answers), touched = useRef(new Set<string>()), revision = useRef(initial.questionnaire?.revision ?? 0), saving = useRef<Promise<boolean> | null>(null)
  const calendarRef = useRef<HTMLDivElement>(null), busyRef = useRef(false), refreshEpoch = useRef(0), bookingRequest = useRef('')
  const file = data.file, board = data.board, clients = data.clients ?? [], isAdmin = data.user.role === 'SUPER_ADMIN'
  const tz = board?.timezone ?? file?.timezone ?? 'America/Los_Angeles'
  const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const closers = board?.closers ?? file?.closers ?? []
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function notify(message: string) { setToast(message); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 6000) }
  async function refresh(month?: string) {
    const epoch = ++refreshEpoch.current
    const params = new URLSearchParams({ view, ...query, ...(clientId ? { clientId } : {}), ...(month || board?.month ? { month: month ?? board!.month } : {}) })
    const response = await fetch(`/api/desk?${params}`, { cache: 'no-store' })
    if (!response.ok) { if ([401, 403, 404].includes(response.status)) router.refresh(); throw Error('Unable to refresh this view') }
    const next: FinalDeskPayload = await response.json(); if (epoch !== refreshEpoch.current) return; setData(next)
    if (next.questionnaire && !touched.current.size && !saving.current) { answerRef.current = next.questionnaire.answers; setAnswers(next.questionnaire.answers); revision.current = next.questionnaire.revision }
  }
  useEffect(() => { const tick = () => setNow(new Date()); const timer = setInterval(tick, 15000); tick(); return () => { clearInterval(timer); if (toastTimer.current) clearTimeout(toastTimer.current) } }, [])
  useEffect(() => { const timer = setInterval(() => { if (!busyRef.current && !busy && !modal && !look && view !== 'questionnaire') void refresh().catch(() => {} ) }, 15000); return () => clearInterval(timer) })
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
  const go = async (next: string) => { if (view !== 'questionnaire' || await flush()) router.push(paths[next]) }
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
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.pdf,.png,.jpg,.jpeg,.heic,.webp,.txt,.eml'
    input.onchange = () => { const selected = input.files?.[0]; if (!selected || !file) return
      void run(async () => { const body = new FormData(); body.set('clientId', file.id); body.set('file', selected); body.set('label', tile.label); if (tile.requirementId) body.set('requirementId', tile.requirementId)
        const response = await fetch('/api/documents/upload', { method: 'POST', body }); const result = await response.json(); if (!response.ok) return { ok: false, error: result.error || 'Upload failed' }; return { ok: true, message: result.extraction?.status === 'FAILED' ? 'Original saved; extraction needs attention' : `${selected.name} uploaded · ${tile.label}` }
      }, 'Document uploaded') }
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
  async function selectDay(next: string) { setDay(next); setMode('day'); if (next.slice(0, 7) !== board?.month) await refresh(next.slice(0, 7)) }
  function shiftDay(delta: number) { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + delta); void selectDay(date.toISOString().slice(0, 10)) }
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
    return <div key={c.appointmentId} className={`${agenda ? 'appt' : 'chip'}${c.ownerName ? '' : ' u'}`} style={agenda ? { top, height: 56 } : undefined} onClick={e => { e.stopPropagation(); open(c.clientId) }} onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, chip: c }) }}><span className="chip-time">🕐 {fmt(c.startsAt, tz)}</span><b>{c.firstName} {c.lastName}</b><span className="closer">{c.ownerName ? `Closer - ${c.ownerName}` : 'Unassigned'}</span></div>
  }
  let content: ReactNode = null
  if (view === 'board' && board) {
    const dayChips = liveChips.filter(c => civilDate(new Date(c.startsAt), tz) === day)
    const dayTitle = day ? new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : ''
    const today = now ? civilDate(now, tz) : board.today
    content = mode === 'month' ? <><div className="banner">{board.unassignedCount} unassigned leads. Click a day for the hour view · click a name for the file.</div><div className="grid board-grid"><div className="card" ref={calendarRef}><div className="head"><h2>{board.title}</h2><button className="btn secondary" onClick={() => void selectDay(today)}>Today</button></div><div className="week">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(w => <span key={w}>{w}</span>)}</div><div className="days">{board.days.map(d => <div key={d.iso} className={`day${d.inMonth ? '' : ' mute'}${d.iso === today ? ' today' : ''}`} onClick={() => d.inMonth && void selectDay(d.iso)} onDragOver={e => e.preventDefault()} onDrop={e => d.inMonth && drop(e, d.iso)}>{d.inMonth && <><span className="num">{d.day}</span>{d.chips.filter(c => ['SCHEDULED','CONFIRMED'].includes(c.status)).map(c => chip(c))}</>}</div>)}</div></div>{unscheduled}</div></>
      : <><div className="banner">{dayChips.length ? `${dayChips.length} appointment${dayChips.length === 1 ? '' : 's'} this day. Click a block to open the file.` : 'No appointments this day. Drag someone from Unscheduled onto an hour.'}</div><div className="grid board-grid"><div className="card" ref={calendarRef}><div className="head"><h2>{dayTitle}</h2><div className="actions"><button className="btn secondary" onClick={() => shiftDay(-1)}>←</button><button className="btn secondary" onClick={() => void selectDay(today)}>Today</button><button className="btn secondary" onClick={() => shiftDay(1)}>→</button><button className="btn" onClick={() => setMode('month')}>Month</button></div></div><div className="agenda" style={{ padding: '0 0 18px' }}><div>{Array.from({ length: 12 }, (_, i) => <div className="agenda-hour" key={i}>{i + 8 < 12 ? `${i + 8} AM` : `${(i + 8) % 12 || 12} PM`}</div>)}</div><div className="agenda-track" style={{ minHeight: 768 }}>{Array.from({ length: 12 }, (_, i) => <div key={i} className="agenda-slot" onDragOver={e => e.preventDefault()} onDrop={e => drop(e, day, `${String(i + 8).padStart(2,'0')}:00`)} />)}{dayChips.map(c => chip(c, true))}{now && day === today && mins(timeLabel(now, tz)) >= 480 && mins(timeLabel(now, tz)) <= 1200 && <div className="nowline" style={{ top: (mins(timeLabel(now, tz)) - 480) / 60 * 64 }} />}</div></div>{!dayChips.length && <div className="empty-day">Nothing booked for {dayTitle}.</div>}</div>{unscheduled}</div></>
  } else if (view === 'profile' && file) {
    const q = data.questionnaire!, progress = answerCount(q.answers)
    content = <><article className="card ph"><div><button className="btn secondary" onClick={() => go('board')}>← Board</button><div className="who">{String(q.answers.legal_name || `${file.firstName} ${file.lastName}`)}</div><div className="muted">{file.city}, {file.state} {file.zip} · {file.source} · {file.stage}</div><div className="tags"><span className={`tag ${file.ownerName ? 'g' : 'w'}`}>Owner: {file.ownerName || 'Unassigned'}</span><span className="tag">{file.appointmentLabel ? `Appt ${file.appointmentLabel}` : 'Not booked'}</span><span className="tag">Docs {file.docsPresent}/8</span><span className={`tag ${file.extractionLabel === 'verified' ? 'g' : 'w'}`}>Extraction {file.extractionLabel}</span><span className={`tag ${file.creditOnFile ? 'g' : 'w'}`}>{file.creditOnFile ? `Credit ${file.creditLabel}` : 'Credit not on file'}</span></div></div><div className="actions">{file.canAssign && <button className="btn" onClick={() => openModal('assign')}>Assign closer</button>}<button className="btn secondary" disabled={!file.canBook} onClick={() => openModal('book')}>{file.appointmentLabel ? 'Reschedule' : 'Book'}</button><button className="btn secondary" onClick={() => void draftRequest()}>Request missing docs</button><button className="btn secondary" onClick={() => void copyContact()}>Call</button></div></article><div className="g2"><div className="card block"><h3>Finance agreement</h3><div className="math">{file.finance.map(c => <Cell key={c.label} value={c} />)}</div></div><div className="card block"><h3>Solar / intake</h3><div className="math">{file.solar.map(c => <Cell key={c.label} value={c} />)}</div></div></div><div className="card block" style={{ marginBottom: 14 }}><h3>Documents</h3><p className="muted" style={{ margin: '-4px 0 12px' }}>Click Quick look to open the page. Live desk will load the real file; this prototype shows the extract when a document exists.</p><div className="docs">{file.docs.map(d => <div key={d.key} className="doc"><div className="doc-top"><span>{d.label}</span><div className="doc-acts"><button className="lookbtn" onClick={() => setLook(d)}>Quick look</button><button className="lookbtn" disabled={busy || !file.canUpload} onClick={() => void upload(d)}>Upload</button></div></div><div className={`st ${d.state === 'missing' || d.state === 'failed' ? 'm' : 'g'}`}>{d.state}</div></div>)}</div></div><div className="g2"><div className="card block"><h3>Intake answers · verbatim</h3><div className="qa">{file.intake.map((a, i) => <div key={i}><b>{a.question}</b>{a.answer}</div>)}</div><button className="qtab" style={{ margin: '14px 0 0' }} onClick={() => router.push(`/clients/${file.id}/questionnaire`)}><div><b>Client&apos;s Questionnaire Form</b><div className="muted">{q.done ? 'All 42 answered' : `${progress} of 42 answered · finish on the booking call`}</div></div><div className={`mark tag ${q.done ? 'g' : 'w'}`}>{q.done ? '✓ Completed' : 'In progress'}</div></button></div><div className="card block prose"><h3>Redline · internal posture</h3><p><b>On the page:</b> {file.redline.facts}</p><p><b>Intake vs page:</b> {file.redline.vs}</p><p><b>State</b></p><ul>{file.redline.state.map((t, i) => <li key={i}>{t}</li>)}</ul><p><b>Federal</b></p><ul>{file.redline.federal.map((t, i) => <li key={i}>{t}</li>)}</ul><p><b>Blockers:</b> {file.redline.blockers.join(', ')}.</p><span className="flag">Flag · {file.redline.flag}</span></div></div><div className="card block prose" style={{ marginTop: 14 }}><h3>Closer brief {file.brief?.approved ? '· approved' : ''}</h3><p>{file.brief?.body || 'No closer brief on file.'}</p><p>Surprise numbers: {file.brief?.sur.join('; ') || 'Not on file'}.</p><p>First ask: {file.brief?.ask || 'Review the available documents'}.</p><p>Suggested open: {file.brief?.open || 'Not on file'}.</p><div className="actions" style={{ marginTop: 10 }}><button className="btn" disabled={busy || !file.brief} onClick={() => void run(() => approveBriefAction({ clientId: file.id, briefId: file.brief!.id }), 'Brief approved')}>{file.brief?.approved ? 'Approved' : 'Approve brief'}</button><button className="btn secondary" disabled={busy || !file.brief} onClick={() => { const body = window.prompt('Edit closer brief', file.brief!.body); if (body?.trim()) void run(() => editBriefAction({ clientId: file.id, briefId: file.brief!.id, body }), 'Brief updated · needs approve') }}>Edit</button></div></div></>
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
  return <div className="final-desk" onClick={() => menu && setMenu(null)}><div className="shell"><aside className="rail"><div className="brand"><small>SCS operations</small><strong>ProdigyFlo</strong></div><nav className="nav">{['board','clients','queue'].map(v => <button key={v} className={view === v ? 'on' : ''} onClick={() => go(v)}>{v === 'queue' ? `Queue · ${data.queueCount}` : titles[v as DeskView]}</button>)}<div className="sec">More</div>{['engine','documents','submissions','users'].filter(v => isAdmin || !['engine','users'].includes(v)).map(v => <button key={v} className={view === v ? 'on' : ''} onClick={() => go(v)}>{titles[v as DeskView]}</button>)}</nav><div className="rail-foot"><b>{data.user.name}</b>{isAdmin ? 'Super Admin' : 'Closer'}<br />Invite-only desk<br /><button className="out" onClick={() => void signOut({ callbackUrl: '/login' })}>Sign out</button></div></aside><div className="col"><header className="top"><div><h1>{titles[view]}</h1><div className="muted">{now ? `${now.toLocaleDateString('en-US', { timeZone: viewerTz, weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })} · 🕐 ${now.toLocaleTimeString('en-US', { timeZone: viewerTz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}` : ''}</div></div><div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><div className={`alarm${soon ? ' hot' : ''}`}><span className="bell">⏰</span><span>{soon && now ? `${soon.firstName} ${soon.lastName} · in ${Math.max(1, Math.ceil((new Date(soon.startsAt).getTime() - now.getTime()) / 60000))} min` : 'No call in the next 30 min'}</span></div><div className="muted">Not a law firm · review only</div></div></header><main className="main">{content}</main></div></div>
    {modal && <div className="modal on"><div className="box"><h3>{modal === 'assign' ? 'Assign closer' : 'Book / reschedule'}</h3>{modal === 'assign' ? <><select aria-label="Closer" value={closer} onChange={e => setCloser(e.target.value)}>{closers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><textarea aria-label="Optional note" placeholder="Optional note" rows={3} value={note} onChange={e => setNote(e.target.value)} /></> : <><input aria-label="Appointment date" type="date" value={bookDate} onChange={e => { bookingRequest.current = crypto.randomUUID(); setBookDate(e.target.value) }} /><input aria-label="Appointment time" type="time" value={bookTime} onChange={e => { bookingRequest.current = crypto.randomUUID(); setBookTime(e.target.value) }} /></>}<div className="actions"><button className="btn" disabled={busy || (modal === 'assign' ? !closer : !bookDate || !bookTime)} onClick={() => void run(() => modal === 'assign' ? assignDeskCloserAction({ clientId: target.id, closerId: closer, note }) : bookAppointmentAction({ clientId: target.id, appointmentId: target.appointmentId, expectedUpdatedAt: target.expectedUpdatedAt, requestId: bookingRequest.current, date: bookDate, time: bookTime }), modal === 'assign' ? 'Closer assigned' : 'Appointment saved')}>{modal === 'assign' ? 'Confirm' : 'Save'}</button><button className="btn secondary" disabled={busy} onClick={() => setModal(null)}>Cancel</button></div></div></div>}
    {look && <div className="modal on" onClick={e => { if (e.currentTarget === e.target) setLook(null) }}><div className="lookbox"><div className="lookhead"><div><div className="muted" style={{ fontSize: 11, letterSpacing: '.12em', textTransform: 'uppercase' }}>Quick look</div><h3>{look.label}</h3><div className="muted">{file?.firstName} {file?.lastName} · {file?.city}, {file?.state} {file?.zip} · {look.state}</div></div><button className="btn secondary" onClick={() => setLook(null)}>Close</button></div>{look.fileUrl ? <div style={{ width: '100%', height: '65vh', overflow: 'auto', padding: 16 }}>{look.mimeType === 'application/pdf' ? <PdfPreview key={look.fileUrl} title={look.label} url={look.fileUrl} /> : <iframe title={look.label} src={look.fileUrl} style={{ width: '100%', height: '100%', border: 0 }} />}</div> : <div className="empty-look"><div className="v m" style={{ fontSize: 20 }}>Not on file</div><p>This document is not available for {file?.firstName} yet.</p><button className="btn" onClick={() => void draftRequest(look)}>Request {look.label}</button></div>}</div></div>}
    {menu && <div className="menu" style={{ display: 'block', left: menu.x, top: menu.y }}>{['View profile', ...(isAdmin ? ['Assign closer'] : []), 'Reschedule', 'Copy contact', 'Mark no-show'].map(label => <button key={label} onClick={() => { const c = menu.chip; if (label === 'View profile') open(c.clientId); else if (label === 'Assign closer') openModal('assign', c.clientId, c.appointmentId); else if (label === 'Reschedule') { openModal('book', c.clientId, c.appointmentId, c.updatedAt); setBookDate(civilDate(new Date(c.startsAt), tz)); setBookTime(timeLabel(new Date(c.startsAt), tz)) } else if (label === 'Copy contact') void copyContact(c); else void run(() => markNoShowAction({ clientId: c.clientId, appointmentId: c.appointmentId }), 'Appointment marked no-show') }}>{label}</button>)}</div>}
    {toast && <div className="toast" role="status" style={{ display: 'block' }}>{toast}</div>}
  </div>
}
