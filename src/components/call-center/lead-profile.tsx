'use client'

import { SunoffPill } from './sunoff-pill'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { approveBriefAction, editBriefAction } from '@/app/(app)/clients/[clientId]/closeops-actions'
import type { CaseDocTile } from '@/lib/daily-desk-case-types'
import { loadLeadProfile, type LeadProfileData } from '@/lib/call-center/lead-profile-actions'
import {
  agoLabel,
  canCysSignUp,
  canResendProfile,
  canScsIntake,
  formatWhen,
  handoffChip,
  intakeSentLine,
  profileStateOf,
  textHeldUntilMorning,
  triesCount,
  type CallLead,
  type IntakeMode,
  type LeadHandoff,
} from '@/lib/call-center/model'
import { DocumentQuicklook } from '../final-desk/document-quicklook'
import {
  CloserBriefSection,
  DocumentsSection,
  FinanceSection,
  IntakeSection,
  LeadSourceSection,
  QuestionnaireProgress,
  RedlineSection,
  SolarSection,
  UPLOAD_ACCEPT,
  uploadDocumentFile,
} from '../final-desk/profile-sections'
import {
  linkLeadToClient,
  possibleMatchFor,
  provisionSunoffUser,
  refreshSunoffHandoff,
  scsIntakeLink,
  scsIntakeTextStatus,
  startSunoffHandoff,
  sunoffHandoffState,
  type HandoffResult,
  type PossibleMatch,
} from './handoff-adapter'

/** Phones open SunOff / SCS in this tab; a desk opens a new one (docs/CYS_BRIDGE.md §B3.2). */
const PHONE_QUERY = '(max-width: 767.98px)'

function onPhone(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(PHONE_QUERY).matches
}

/**
 * Open the tab inside the click, before any await, so popup blockers allow
 * it; point it at the real url once the server answers. Null on a phone,
 * which navigates this tab instead.
 */
function preOpenTab(): Window | null {
  if (onPhone()) return null
  const tab = window.open('about:blank', '_blank')
  if (tab) tab.opener = null
  return tab
}

function goTo(tab: Window | null, url: string) {
  if (tab) tab.location.href = url
  else window.location.assign(url)
}

export type LeadHandoffApi = ReturnType<typeof useLeadHandoff>

/**
 * Everything the SCS Intake and CYS Sign up buttons do, shared by the Handoff
 * group and the profile column. All calls go through server actions
 * (handoff-adapter); the screen never builds a URL itself.
 */
export function useLeadHandoff({ lead, rep, holds, admin, now, onChanged, onPreview }: {
  lead: CallLead | null
  /** Who the lock rules check against (the viewer id, or "You" on the seed desk). */
  rep: string
  holds: boolean
  admin: boolean
  now: number
  /** Something changed on the server: reload the desk rows. */
  onChanged: () => void
  /** A seed (preview) lead: no server, record it on this screen only. */
  onPreview: (lead: CallLead, mode: IntakeMode) => void
}) {
  const leadId = lead?.id ?? null
  const clientId = lead?.clientId ?? null
  const persisted = Boolean(lead?.persisted)
  const key = `${leadId}|${clientId}`
  const [busy, setBusy] = useState(false)
  // Per-lead results, keyed so another lead never shows this one's state.
  const [note, setNote] = useState<{ key: string; text: string } | null>(null)
  const [needsSunoff, setNeedsSunoff] = useState<string | null>(null)
  const [server, setServer] = useState<{ key: string; handoff: LeadHandoff | null } | null>(null)
  const [match, setMatch] = useState<{ key: string; match: PossibleMatch | null; canLink: boolean } | null>(null)
  const [textGate, setTextGate] = useState<{ key: string; reason: string | null } | null>(null)

  useEffect(() => {
    if (!leadId || !persisted) return
    let cancel = false
    if (clientId) {
      sunoffHandoffState(leadId).then((state) => {
        if (cancel) return
        setServer({ key, handoff: state ? { status: state.status, at: state.lastSentAt, stale: state.stale, lastError: state.lastError } : null })
      }).catch(() => {})
    } else {
      possibleMatchFor(leadId).then((result) => {
        if (!cancel && result.ok) setMatch({ key, match: result.match, canLink: result.canLink })
      }).catch(() => {})
      scsIntakeTextStatus(leadId).then((result) => {
        if (!cancel) setTextGate({ key, reason: result.ok ? null : result.reason })
      }).catch(() => {})
    }
    return () => { cancel = true }
  }, [leadId, clientId, persisted, key])

  const handoff = (server?.key === key ? server.handoff : null) ?? lead?.handoff ?? null
  const textBlock = !lead
    ? null
    : lead.intakeTextBlock ?? (textGate?.key === key ? textGate.reason : null) ?? (now && textHeldUntilMorning(lead, new Date(now).toISOString()) ?'Texts wait until 9am their time' : null)
  const say = (text: string) => setNote({ key, text })

  async function intake(mode: IntakeMode) {
    if (!lead || busy) return
    if (!lead.persisted) {
      onPreview(lead, mode)
      say('Preview lead: nothing was sent.')
      return
    }
    const tab = mode === 'open' ? preOpenTab() : null
    setBusy(true)
    try {
      const result = await scsIntakeLink(lead.id, mode)
      if (!result.ok) {
        tab?.close()
        say(result.reason)
        return
      }
      if (mode === 'open' && result.url) goTo(tab, result.url)
      else tab?.close()
      if (mode === 'copy' && result.url) {
        try {
          await navigator.clipboard.writeText(result.url)
          say('Intake link copied.')
        } catch {
          say('Copy blocked by the browser. Try again.')
        }
      }
      if (mode === 'text') say(result.sent ? 'Intake link texted.' : 'The text did not go out.')
      onChanged()
    } catch {
      tab?.close()
      say('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  async function signUp(resend = false) {
    if (!lead || busy) return
    const tab = resend ? null : preOpenTab()
    setBusy(true)
    try {
      const result: HandoffResult = resend ? await refreshSunoffHandoff(lead.id) : await startSunoffHandoff(lead.id)
      if (!result.ok) {
        tab?.close()
        if (result.code === 'NO_SUNOFF_USER') setNeedsSunoff(key)
        if (result.code === 'SUNOFF_DOWN') setServer({ key, handoff: { status: 'ERROR', at: null, lastError: result.reason } })
        say(result.reason)
        return
      }
      setNeedsSunoff(null)
      setServer({ key, handoff: { status: result.status, at: new Date().toISOString(), stale: false } })
      if (resend) say('Profile re-sent to SunOff.')
      else goTo(tab, result.url)
      onChanged()
    } catch {
      tab?.close()
      say('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  async function provision() {
    if (busy) return
    setBusy(true)
    try {
      const result = await provisionSunoffUser()
      if (result.ok) {
        setNeedsSunoff(null)
        say(result.message ?? `SunOff account created. Check ${result.email} for the set-password link, then press CYS Sign up again.`)
      } else say(result.reason)
    } catch {
      say('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  async function link(target: string) {
    if (!lead || busy) return
    setBusy(true)
    try {
      const result = await linkLeadToClient(lead.id, target)
      if (result.ok) {
        say('Linked. Loading the profile…')
        onChanged()
      } else say(result.reason)
    } catch {
      say('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return {
    lead,
    busy,
    note: note?.key === key ? note.text : null,
    needsSunoff: needsSunoff === key,
    handoff,
    match: match?.key === key ? match : null,
    textBlock,
    canIntake: Boolean(lead && holds && canScsIntake(lead, rep)),
    canSignUp: Boolean(lead && canCysSignUp(lead, holds, admin)),
    intake,
    signUp,
    provision,
    link,
  }
}

/** SCS Intake (split button) and CYS Sign up, the lead panel's Handoff group. */
export function HandoffGroup({ api, onOpenProfile }: { api: LeadHandoffApi; onOpenProfile: () => void }) {
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const lead = api.lead
  useEffect(() => {
    if (!menu) return
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !menuRef.current?.contains(event.target as Node)) setMenu(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [menu])
  if (!lead) return null
  const chip = handoffChip(api.handoff)
  const pick = (mode: IntakeMode) => {
    setMenu(false)
    void api.intake(mode)
  }
  return (
    <div className="handoff">
      {lead.clientId ? (
        <button type="button" className="btn secondary" onClick={onOpenProfile}>Intake linked · open profile</button>
      ) : (
        <div className="split-btn" ref={menuRef}>
          <button type="button" className="btn" disabled={!api.canIntake || api.busy} onClick={() => pick('open')}>SCS Intake</button>
          <button
            type="button"
            className="btn split-caret"
            aria-label="SCS Intake options"
            aria-haspopup="menu"
            aria-expanded={menu}
            disabled={!api.canIntake || api.busy}
            onClick={() => setMenu((open) => !open)}
          >
            <span aria-hidden="true">▾</span>
          </button>
          {menu ? (
            <div className="split-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => pick('open')}>
                <b>Open with client (live)</b>
                <span>You fill it together on this call</span>
              </button>
              <button type="button" role="menuitem" disabled={Boolean(api.textBlock)} onClick={() => pick('text')}>
                <b>Text link</b>
                <span>{api.textBlock ?? 'They finish it on their own phone'}</span>
              </button>
              <button type="button" role="menuitem" onClick={() => pick('copy')}>
                <b>Copy link</b>
                <span>Paste it wherever you need</span>
              </button>
            </div>
          ) : null}
        </div>
      )}
      {lead.clientId ? (
        <div className="cys-row">
          {chip ? (
            <button
              type="button"
              className={`btn secondary cys-chip s-${api.handoff?.status.toLowerCase()}`}
              disabled={!api.canSignUp || api.busy}
              title="Open this lead in SunOff"
              onClick={() => { void api.signUp() }}
            >
              {chip}
            </button>
          ) : (
            <button type="button" className="btn" disabled={!api.canSignUp || api.busy} onClick={() => { void api.signUp() }}>
              ✍️ CYS Sign up
            </button>
          )}
          {canResendProfile(api.handoff) ? (
            <button type="button" className="btn secondary" disabled={!api.canSignUp || api.busy} onClick={() => { void api.signUp(true) }}>
              Re-send profile
            </button>
          ) : null}
        </div>
      ) : null}
      {api.needsSunoff ? (
        <div className="banner sunoff-link" role="status">
          <span><b>Link your SunOff account.</b> CYS Sign up opens the lead in SunOff under your own SunOff login, and you don&rsquo;t have one yet.</span>
          <button type="button" className="btn secondary" disabled={api.busy} onClick={() => { void api.provision() }}>Create my SunOff account</button>
        </div>
      ) : null}
      {api.note ? <p className="muted" role="status">{api.note}</p> : null}
    </div>
  )
}

type Loaded = { key: string; profile: LeadProfileData | null; error: string | null }

/** The profile column (≥1024) / Profile tab (<1024) of the lead panel: the four lead states of §B2. */
export function LeadProfile({ api, now, sheetHost }: { api: LeadHandoffApi; now: number; sheetHost: HTMLElement | null }) {
  const lead = api.lead
  const leadId = lead?.id ?? null
  const clientId = lead?.clientId ?? null
  const key = `${leadId}|${clientId}`
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [epoch, setEpoch] = useState(0)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [look, setLook] = useState<CaseDocTile | null>(null)

  useEffect(() => {
    if (!leadId || !clientId) return
    let cancel = false
    loadLeadProfile(leadId).then((result) => {
      if (!cancel) setLoaded({ key, profile: result.ok ? result.profile : null, error: result.ok ? null : result.reason })
    }).catch(() => {
      if (!cancel) setLoaded({ key, profile: null, error: 'Could not load the profile.' })
    })
    return () => { cancel = true }
  }, [leadId, clientId, key, epoch])

  if (!lead) return null
  const mine = loaded?.key === key ? loaded : null
  const profile = mine?.profile ?? null
  const state = profileStateOf(lead, Boolean(profile?.analysing))
  const chip = handoffChip(api.handoff)

  async function write(run: () => Promise<{ ok?: boolean; error?: string; message?: string }>, done: string) {
    if (busy) return
    setBusy(true)
    try {
      const result = await run()
      setToast(result.ok === false || result.error ? (result.error ?? 'Action failed') : (result.message ?? done))
      setEpoch((n) => n + 1)
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  function upload(tile: CaseDocTile) {
    const file = profile?.file
    if (!file || profile.readOnly) return
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = UPLOAD_ACCEPT
    input.onchange = () => {
      const selected = input.files?.[0]
      if (selected) void write(() => uploadDocumentFile(file.id, tile, selected), 'Document uploaded')
    }
    input.click()
  }

  const facts = (
    <dl className="facts">
      <div><dt>Name</dt><dd>{lead.name}{lead.sourceBrand ? <> <SunoffPill /></> : null}</dd></div>
      <div><dt>ZIP</dt><dd>{lead.zip ?? '—'}</dd></div>
      <div><dt>Page</dt><dd>{lead.page}</dd></div>
      <div><dt>Tries</dt><dd>{triesCount(lead)}</dd></div>
      <div><dt>Came in</dt><dd>{formatWhen(lead.arrivedAt)}</dd></div>
    </dl>
  )

  let body: React.ReactNode
  if (state === 'no_intake') {
    body = (
      <div className="card block profile-state" data-state="no_intake">
        <h3>Client profile</h3>
        {facts}
        <p className="state-line"><b>No intake yet.</b> The profile fills in once they finish the SCS intake.</p>
        <button type="button" className="btn" disabled={!api.canIntake || api.busy} onClick={() => { void api.intake('open') }}>Start SCS Intake</button>
      </div>
    )
  } else if (state === 'link_sent') {
    const sent = lead.intake!
    const again: IntakeMode = sent.mode === 'text' && !api.textBlock ? 'text' : 'copy'
    body = (
      <div className="card block profile-state" data-state="link_sent">
        <h3>Client profile</h3>
        {facts}
        <p className="state-line"><b>{intakeSentLine(sent, now)}.</b> Not a client until they finish the intake.</p>
        <div className="actions">
          <button type="button" className="btn secondary" disabled={!api.canIntake || api.busy} onClick={() => { void api.intake(again) }}>
            {again === 'text' ? 'Resend text' : 'Resend'}
          </button>
          <button type="button" className="btn secondary" disabled={!api.canIntake || api.busy} onClick={() => { void api.intake('copy') }}>Copy link</button>
        </div>
        {api.match?.match ? (
          <div className="match-card" data-testid="possible-match">
            <span>Possible match: <b>{api.match.match.firstName}</b> · client since {agoLabel(api.match.match.createdAt, now)}</span>
            {api.match.canLink ? (
              <button type="button" className="btn secondary" disabled={api.busy} onClick={() => { void api.link(api.match!.match!.clientId) }}>Link</button>
            ) : <span className="muted">An admin can link it.</span>}
          </div>
        ) : null}
      </div>
    )
  } else if (!profile) {
    body = (
      <div className="card block profile-state" data-state="loading" aria-busy={!mine}>
        <h3>Client profile</h3>
        {mine?.error ? <p className="muted">{mine.error}</p> : <div className="skeleton" aria-label="Loading profile"><i /><i /><i /></div>}
      </div>
    )
  } else {
    const file = profile.file
    body = (
      <>
        <div className="card block profile-head" data-state={state}>
          <h3>Client profile</h3>
          <div className="who">{file.firstName} {file.lastName}</div>
          <div className="muted">{[file.city, file.state, file.zip].filter(Boolean).join(', ') || '—'} · {file.stage}</div>
          <div className="tags">
            <span className={`tag ${file.ownerName ? 'g' : 'w'}`}>Owner: {file.ownerName || 'Unassigned'}</span>
            <span className="tag">Docs {file.docsPresent}/8</span>
            <span className={`tag ${file.extractionLabel === 'verified' ? 'g' : 'w'}`}>Extraction {file.extractionLabel}</span>
            {chip ? <span className="tag">{chip}</span> : null}
            {profile.readOnly ? <span className="tag w" data-testid="read-only">Read-only</span> : null}
          </div>
          {state === 'analysing' ? (
            <p className="state-line" data-testid="analysing">
              <b>Intake received{profile.intakeAt ? ` ${agoLabel(profile.intakeAt, now)}` : ''} · documents analysing.</b> Figures fill in as the extraction finishes.
            </p>
          ) : null}
          {!profile.readOnly ? <a className="linkish" href={`/clients/${encodeURIComponent(file.id)}`} target="_blank" rel="noopener noreferrer">Open the full file ↗</a> : null}
        </div>
        {file.leadAttribution?.length ? <LeadSourceSection rows={file.leadAttribution} /> : null}
        <div className="g2"><FinanceSection cells={file.finance} /><SolarSection cells={file.solar} /></div>
        {profile.docsHidden ? null : (
          <DocumentsSection
            docs={file.docs}
            canUpload={file.canUpload && !profile.readOnly}
            busy={busy}
            onLook={(tile) => { if (profile.readOnly) setToast('Files open for the file’s closer or an admin.'); else setLook(tile) }}
            onUpload={upload}
          />
        )}
        <div className="g2">
          <IntakeSection intake={file.intake}>
            <QuestionnaireProgress
              done={profile.questionnaire.done}
              progress={profile.questionnaire.progress}
              href={profile.readOnly ? undefined : `/clients/${encodeURIComponent(file.id)}/questionnaire`}
            />
          </IntakeSection>
          <RedlineSection state={file.state} redline={file.redline} />
        </div>
        <CloserBriefSection
          file={file}
          busy={busy}
          readOnly={profile.readOnly}
          onApprove={() => { if (file.brief) void write(() => approveBriefAction({ clientId: file.id, briefId: file.brief!.id }), 'Brief approved') }}
          onEdit={() => {
            if (!file.brief) return
            const text = window.prompt('Edit closer brief', file.brief.body)
            if (text?.trim()) void write(() => editBriefAction({ clientId: file.id, briefId: file.brief!.id, body: text }), 'Brief updated · needs approve')
          }}
        />
        {look && sheetHost
          ? createPortal(
              <DocumentQuicklook
                key={look.key}
                tile={look}
                allFiles={file.availableFiles ?? []}
                clientLabel={`${file.firstName} ${file.lastName} · ${file.city}, ${file.state} ${file.zip}`}
                firstName={file.firstName}
                onClose={() => setLook(null)}
                onRequest={() => { setToast(`Ask ${file.firstName} for the ${look.label}.`); setLook(null) }}
              />,
              sheetHost,
            )
          : null}
      </>
    )
  }

  return (
    <div className="lead-profile">
      {body}
      {toast ? <p className="muted" role="status">{toast}</p> : null}
    </div>
  )
}
