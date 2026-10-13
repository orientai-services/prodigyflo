/**
 * The dialer app's shell (docs/DIALER_APP.md §1, §2): which section a URL
 * opens, the links between sections, and the small pure readings the Today
 * section and the tab badges make of the desk's leads. No React, no I/O.
 */

import { dayKey } from './cadence'
import { durationLabel } from './history-format'
import { ZONE, followUpOf, visibleLeads, type CallLead, type LanguageFilter, type LeadTab, type TrailEvent } from './model'

export type DialerSection = 'today' | 'messages' | 'leads' | 'booked' | 'history' | 'team'

/** The six tabs, in bar order. More is a sheet, not a section; Team opens from it. */
export const TAB_SECTIONS = ['today', 'messages', 'leads', 'booked', 'history'] as const

export const SECTION_TITLE: Record<DialerSection, string> = {
  today: 'Today',
  messages: 'Messages',
  leads: 'Leads',
  booked: 'Booked',
  history: 'History',
  team: 'Team',
}

/** The Leads filters. `due` backs the Today "Follow-ups today" tile; `missed` shows the missed-calls list. */
export type DeskFilter = LeadTab | 'due' | 'missed'

export const LEAD_FILTERS: readonly { id: DeskFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'forms', label: 'Forms' },
  { id: 'inbound', label: 'Inbound' },
  { id: 'uncontacted', label: 'Not contacted' },
  { id: 'due', label: 'Follow-ups' },
  { id: 'retry', label: 'Retry' },
  { id: 'dnc', label: 'Do not call' },
  { id: 'missed', label: 'Missed' },
]

export const HISTORY_BASE = '/call-center?s=history'
export const MESSAGES_BASE = '/call-center?s=messages'
export const ADS_BASE = '/call-center?s=leads&tab=ads'

type Params = Record<string, string | string[] | undefined>

function one(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value
  return typeof v === 'string' && v ? v : null
}

function isSection(value: string | null): value is DialerSection {
  return value !== null && (Object.keys(SECTION_TITLE) as string[]).includes(value)
}

function isFilter(value: string | null): value is DeskFilter {
  return LEAD_FILTERS.some((f) => f.id === value)
}

export type ShellRoute = {
  section: DialerSection
  /** Leads is showing the Ads dashboard (More › Campaigns, old `?tab=ads`). */
  ads: boolean
  /** The Leads filter the URL asked for, if any. */
  filter: DeskFilter | null
}

/**
 * `?s=` picks the section (default Today). Old deep links keep working:
 * `?tab=ads` is Leads with the Ads view, `?tab=calendar` is Booked, and
 * `?lead=` / `?missed=` open Leads.
 */
export function resolveRoute(params: Params, opts: { adsAllowed: boolean }): ShellRoute {
  const s = one(params.s)
  const tab = one(params.tab)
  let section: DialerSection
  if (isSection(s)) section = s
  else if (tab === 'calendar') section = 'booked'
  else if (tab === 'ads') section = 'leads'
  else if (one(params.lead) || one(params.missed)) section = 'leads'
  else section = 'today'

  const ads = section === 'leads' && tab === 'ads' && opts.adsAllowed
  const f = one(params.f)
  const filter: DeskFilter | null = section !== 'leads' || ads
    ? null
    : one(params.missed)
      ? 'missed'
      : isFilter(f)
        ? f
        : null
  return { section, ads, filter }
}

export function sectionHref(section: DialerSection, filter?: DeskFilter | null): string {
  return filter && filter !== 'all' ? `/call-center?s=${section}&f=${filter}` : `/call-center?s=${section}`
}

/** Title in the header: Leads reads "Campaigns" while it shows the Ads dashboard. */
export function shellTitle(route: Pick<ShellRoute, 'section' | 'ads'>): string {
  return route.ads ? 'Campaigns' : SECTION_TITLE[route.section]
}

// ── Today ───────────────────────────────────────────────────────────────────

function live(lead: CallLead): boolean {
  return !lead.disabled && !lead.dnc
}

/** Nobody has reached them yet (the Not contacted tile). */
export function waitingFirstCall(lead: CallLead): boolean {
  return live(lead) && !lead.contacted && lead.status !== 'booked'
}

/** A follow-up due today (Pacific) or overdue. */
export function dueToday(lead: CallLead, now: Date): boolean {
  if (!live(lead) || !lead.nextAttemptAt) return false
  const at = new Date(lead.nextAttemptAt)
  return at.getTime() <= now.getTime() || dayKey(at, ZONE) <= dayKey(now, ZONE)
}

export type TodayCounts = { notContacted: number; followUps: number }

export function todayCounts(leads: readonly CallLead[], now: Date): TodayCounts {
  let notContacted = 0
  let followUps = 0
  for (const lead of leads) {
    if (waitingFirstCall(lead)) notContacted += 1
    if (dueToday(lead, now)) followUps += 1
  }
  return { notContacted, followUps }
}

/** The Today tab's badge: follow-ups due + new not contacted. */
export function todayBadge(counts: TodayCounts): number {
  return counts.notContacted + counts.followUps
}

export function badgeText(count: number): string | null {
  if (!count || count < 0) return null
  return count > 99 ? '99+' : String(count)
}

/** The Leads list for a filter. `due` is today's follow-ups by time; `missed` has its own list. */
export function filterLeads(
  leads: readonly CallLead[],
  filter: DeskFilter,
  language: LanguageFilter,
  query: string,
  now: Date,
): CallLead[] {
  if (filter === 'missed') return []
  if (filter === 'due') {
    return visibleLeads([...leads], 'all', language, query)
      .filter((lead) => dueToday(lead, now))
      .sort((a, b) => Date.parse(a.nextAttemptAt as string) - Date.parse(b.nextAttemptAt as string))
  }
  return visibleLeads([...leads], filter, language, query)
}

/** "Monday, October 12" in Pacific time. */
export function dateLine(now: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: ZONE, weekday: 'long', month: 'long', day: 'numeric' }).format(now)
}

/** "just now", "12 min ago", "3 h ago", "4 d ago". */
export function agoLabel(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

/** "Updated just now" / "Updated 3 min ago", from the desk's last server read. */
export function updatedLabel(renderedAtMs: number, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - renderedAtMs) / 60_000)
  if (minutes < 1) return 'Updated just now'
  return `Updated ${minutes} min ago`
}

/** The newest call, text or result with this person, or null. */
export function lastContactAt(lead: CallLead): number | null {
  let latest: number | null = null
  for (const event of lead.trail) {
    if (event.kind !== 'call' && event.kind !== 'inbound' && event.kind !== 'sms' && event.kind !== 'outcome') continue
    const at = Date.parse(event.at)
    if (Number.isFinite(at) && (latest === null || at > latest)) latest = at
  }
  return latest
}

export type StageChip = { label: string; tone: 'new' | 'wait' | 'call' | 'booked' | 'dead' }

/** The row's stage chip: NEW, CALLBACK, MISSED, RETRY, BOOKED, INBOUND, WAITING or DO NOT CALL. */
export function stageOf(lead: CallLead): StageChip {
  if (lead.dnc) return { label: 'DO NOT CALL', tone: 'dead' }
  if (lead.status === 'booked') return { label: 'BOOKED', tone: 'booked' }
  if (followUpOf(lead) === 'callback') return { label: 'CALLBACK', tone: 'call' }
  if (lead.missedCallId) return { label: 'MISSED', tone: 'call' }
  if (!lead.contacted && !lead.nextAttemptAt) return { label: lead.channel === 'inbound' ? 'INBOUND' : 'NEW', tone: 'new' }
  if (lead.nextAttemptAt) return { label: 'RETRY', tone: 'wait' }
  return { label: 'WAITING', tone: 'wait' }
}

/** No number on file, or the last result said the number is wrong: no Call button, a red chip instead. */
export function invalidNumber(lead: CallLead): boolean {
  if (lead.disabled) return false
  if (!lead.last4) return true
  const results = lead.trail.filter((event) => event.kind === 'outcome')
  return results.at(-1)?.label === 'Wrong number'
}

export type LatestRecording = { src: string; seconds: number; at: string; length: string }

/** The newest real recording on the lead (calls and voicemails), for ▶ Listen. */
export function latestRecording(lead: CallLead): LatestRecording | null {
  for (let i = lead.trail.length - 1; i >= 0; i -= 1) {
    const event = lead.trail[i]
    if (event.recording) {
      return { src: event.recording.src, seconds: event.recording.seconds, at: event.at, length: durationLabel(event.recording.seconds) }
    }
  }
  return null
}

/** The newest note, short, with long digit runs hidden: the lead's main issue at a glance. */
export function noteSnippet(lead: CallLead, max = 90): string | null {
  for (let i = lead.trail.length - 1; i >= 0; i -= 1) {
    const text = noteText(lead.trail[i])
    if (text) return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
  }
  return null
}

/** A trail line's note text as the row shows it, or null when it is not the lead's own note. */
export function noteText(event: TrailEvent): string | null {
  if (event.kind !== 'note') return null
  // "Calendar hold placed …" / "Call back due …" are the calendar's own lines, not the lead's note.
  if (/^(Calendar hold placed|Call back due)\b/.test(event.detail)) return null
  return event.detail.replace(/\d{5,}/g, '····').replace(/\s+/g, ' ').trim() || null
}

/** "Thu 9:00 AM" in Pacific time, for a booked visit. */
export function visitLabel(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: ZONE, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
}
