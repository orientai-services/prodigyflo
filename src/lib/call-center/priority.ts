/**
 * The Today view: who to call first, and why. Pure (the clock is passed in)
 * so the ranking is unit-tested and the server, the desk and power mode all
 * agree on the order.
 *
 * Tiers, best first:
 *   0  a callback due within the next hour (or overdue), or an inbound call
 *      we missed today
 *   1  a new lead nobody has reached yet, oldest first; hot after 5 minutes
 *   2  a follow-up that is overdue, most overdue first
 *   3  going cold: reached before, nothing for 3+ days, no follow-up set
 *
 * Do-not-call and disabled leads never rank. Booked leads rank only for a
 * callback that is due. Leads another rep holds still rank (the queues show
 * them, with the lock), but `available` is false so Call first and power
 * mode pass over them.
 */

import { TRY_LIMIT, dayKey, zonedLabel } from './cadence'
import {
  BOOKED_DETAIL,
  CURRENT_REP,
  ZONE,
  canCall,
  channelLabel,
  followUpOf,
  formatWhen,
  isExhausted,
  type CallLead,
} from './model'

export type Tier = 0 | 1 | 2 | 3

export type Ranked = {
  lead: CallLead
  tier: Tier
  /** One plain line: why this lead is here. */
  why: string
  /** New and waiting longer than HOT_AFTER_MS. */
  hot: boolean
  /** This rep may call it now (not do-not-call, not disabled, not held by someone else). */
  available: boolean
  /** Order inside the tier (ms; lower first). */
  key: number
}

export const MINUTE_MS = 60_000
export const HOT_AFTER_MS = 5 * MINUTE_MS
export const CALLBACK_SOON_MS = 60 * MINUTE_MS
export const COLD_AFTER_MS = 3 * 24 * 60 * MINUTE_MS

/** "12 min", "3 h", "4 days". */
export function span(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS))
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h`
  const days = Math.floor(hours / 24)
  return `${days} days`
}

/** The newest thing that happened with this person (not a lock or the form itself). */
export function lastTouchAt(lead: CallLead): number {
  let latest = Date.parse(lead.arrivedAt)
  for (const event of lead.trail) {
    if (event.kind === 'lock' || event.kind === 'form' || event.kind === 'status') continue
    const at = Date.parse(event.at)
    if (at > latest) latest = at
  }
  return latest
}

function missedToday(lead: CallLead, now: Date): boolean {
  if (!lead.missedCallId || !lead.missedCallAt) return false
  return dayKey(new Date(lead.missedCallAt), ZONE) === dayKey(now, ZONE)
}

function triesNote(lead: CallLead): string {
  return lead.tries > 0 ? ` · try ${Math.min(lead.tries + 1, TRY_LIMIT)} of ${TRY_LIMIT}` : ''
}

function callbackWhy(next: number, now: number, zone: string): string {
  const when = zonedLabel(new Date(next).toISOString(), zone, false)
  if (next <= now) return `Callback overdue by ${span(now - next)} · they asked for ${when} their time`
  return `Callback due in ${span(next - now)} · ${when} their time`
}

/** One lead's place in the Today ranking, or null when it doesn't belong there now. */
export function rankLead(lead: CallLead, now: Date, rep: string = CURRENT_REP): Ranked | null {
  if (lead.disabled || lead.dnc) return null
  const t = now.getTime()
  const available = canCall(lead, rep)
  const next = lead.nextAttemptAt ? Date.parse(lead.nextAttemptAt) : null
  const followUp = followUpOf(lead)
  const base = { lead, available, hot: false }

  if (followUp === 'callback' && next !== null && next <= t + CALLBACK_SOON_MS) {
    return { ...base, tier: 0, why: callbackWhy(next, t, lead.timeZone), key: next }
  }
  if (missedToday(lead, now)) {
    const at = Date.parse(lead.missedCallAt as string)
    return { ...base, tier: 0, why: `Called us at ${formatWhen(lead.missedCallAt as string)} and we missed it`, key: at }
  }
  if (lead.status === 'booked') return null

  if (!lead.contacted && next === null) {
    const waited = t - Date.parse(lead.arrivedAt)
    const hot = waited >= HOT_AFTER_MS
    const what = lead.channel === 'form' ? 'New form' : `New ${channelLabel(lead.channel).toLowerCase()}`
    return {
      ...base,
      hot,
      tier: 1,
      why: `${what}, waiting ${span(waited)}${hot ? ' · hot' : ''}`,
      key: Date.parse(lead.arrivedAt),
    }
  }
  if (next !== null && next <= t) {
    return { ...base, tier: 2, why: `Follow-up overdue by ${span(t - next)}${triesNote(lead)}`, key: next }
  }
  if (lead.contacted && next === null && !isExhausted(lead)) {
    const touched = lastTouchAt(lead)
    if (t - touched >= COLD_AFTER_MS) {
      return { ...base, tier: 3, why: `Reached before, nothing for ${span(t - touched)}, no follow-up set`, key: touched }
    }
  }
  return null
}

function byRank(a: Ranked, b: Ranked): number {
  return a.tier - b.tier || a.key - b.key || a.lead.id.localeCompare(b.lead.id)
}

/** Every lead that belongs on Today, best first. */
export function rankLeads(leads: readonly CallLead[], now: Date, rep: string = CURRENT_REP): Ranked[] {
  const out: Ranked[] = []
  for (const lead of leads) {
    const ranked = rankLead(lead, now, rep)
    if (ranked) out.push(ranked)
  }
  return out.sort(byRank)
}

/** The top `count` the rep can actually call now. */
export function callFirst(ranked: readonly Ranked[], count = 3): Ranked[] {
  return ranked.filter((row) => row.available).slice(0, count)
}

/**
 * Power mode's next lead: the best available, saved lead that isn't the one
 * just called and wasn't skipped this session. Seed rows never auto-dial.
 */
export function nextPowerLead(ranked: readonly Ranked[], skip: ReadonlySet<string>, currentId: string | null = null): Ranked | null {
  return ranked.find((row) => row.available && row.lead.persisted && row.lead.id !== currentId && !skip.has(row.lead.id)) ?? null
}

// ── Queues and KPIs ─────────────────────────────────────────────────────────

export type QueueItem = { lead: CallLead; why: string; hot?: boolean }

export type TodayQueues = {
  /** Callbacks the person asked for, and calls of theirs we missed. */
  callbacks: QueueItem[]
  /** Any follow-up whose time has come, ordered by that time. */
  due: QueueItem[]
  /** Not reached yet, oldest first. */
  fresh: QueueItem[]
  /** Reached before and gone quiet, plus leads out of tries. */
  cold: QueueItem[]
}

export type TodayKpis = {
  newNotContacted: number
  followUpsDue: number
  bookedToday: number
  callsToday: number
}

export type TodayBoard = { kpis: TodayKpis; ranked: Ranked[]; callFirst: Ranked[]; queues: TodayQueues }

function live(lead: CallLead): boolean {
  return !lead.disabled && !lead.dnc
}

export function todayQueues(leads: readonly CallLead[], ranked: readonly Ranked[], now: Date): TodayQueues {
  const t = now.getTime()
  const rankOf = new Map(ranked.map((row) => [row.lead.id, row]))

  const callbacks = leads
    .filter((lead) => live(lead) && (followUpOf(lead) === 'callback' || Boolean(lead.missedCallId)))
    .map((lead) => {
      const row = rankOf.get(lead.id)
      const urgent = row?.tier === 0
      const at = followUpOf(lead) === 'callback' && lead.nextAttemptAt
        ? Date.parse(lead.nextAttemptAt)
        : Date.parse(lead.missedCallAt ?? lead.arrivedAt)
      const why = urgent && row
        ? row.why
        : followUpOf(lead) === 'callback' && lead.nextAttemptAt
          ? `Callback ${zonedLabel(lead.nextAttemptAt, lead.timeZone)} their time`
          : `Missed call ${lead.missedCallAt ? formatWhen(lead.missedCallAt) : ''}`.trim()
      return { item: { lead, why }, urgent, at }
    })
    .sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.at - b.at)
    .map((row) => row.item)

  const due = leads
    .filter((lead) => live(lead) && lead.nextAttemptAt && Date.parse(lead.nextAttemptAt) <= t)
    .sort((a, b) => Date.parse(a.nextAttemptAt as string) - Date.parse(b.nextAttemptAt as string))
    .map((lead) => ({
      lead,
      why: followUpOf(lead) === 'callback'
        ? callbackWhy(Date.parse(lead.nextAttemptAt as string), t, lead.timeZone)
        : `Due since ${formatWhen(lead.nextAttemptAt as string)}${triesNote(lead)}`,
    }))

  const fresh = ranked
    .filter((row) => row.tier === 1)
    .map((row) => ({ lead: row.lead, why: row.why, hot: row.hot }))

  const cold = [
    ...ranked.filter((row) => row.tier === 3).map((row) => ({ lead: row.lead, why: row.why })),
    ...leads
      .filter((lead) => live(lead) && isExhausted(lead))
      .map((lead) => ({ lead, why: 'No further tries. Close it as Not interested or Wrong number.' })),
  ]

  return { callbacks, due, fresh, cold }
}

export function todayKpis(leads: readonly CallLead[], now: Date): TodayKpis {
  const t = now.getTime()
  const today = dayKey(now, ZONE)
  const isToday = (iso: string) => dayKey(new Date(iso), ZONE) === today
  let newNotContacted = 0
  let followUpsDue = 0
  let bookedToday = 0
  let callsToday = 0
  for (const lead of leads) {
    if (lead.disabled) continue
    if (live(lead) && !lead.contacted && lead.status !== 'booked') newNotContacted += 1
    if (live(lead) && lead.nextAttemptAt && Date.parse(lead.nextAttemptAt) <= t) followUpsDue += 1
    if (lead.trail.some((event) => event.kind === 'outcome' && event.detail === BOOKED_DETAIL && isToday(event.at))) bookedToday += 1
    callsToday += lead.trail.filter((event) => (event.kind === 'call' || event.kind === 'inbound') && isToday(event.at)).length
  }
  return { newNotContacted, followUpsDue, bookedToday, callsToday }
}

export function todayBoard(leads: readonly CallLead[], now: Date, rep: string = CURRENT_REP): TodayBoard {
  const ranked = rankLeads(leads, now, rep)
  return { kpis: todayKpis(leads, now), ranked, callFirst: callFirst(ranked), queues: todayQueues(leads, ranked, now) }
}
