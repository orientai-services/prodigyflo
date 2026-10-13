import { calendarReps, repColor } from '@/lib/call-center/calendar/config'
import { isLive, parseCalendarParams, rangeFor, type CalendarVM, type RailLeadVM, type VisitVM } from '@/lib/call-center/calendar/planner'
import {
  listFollowUps,
  listSlotsBetween,
  listToSchedule,
  schedulerInputs,
  type CalendarVisit,
  type RailLead,
} from '@/lib/call-center/calendar/service'
import { leadPhonesFor, type LeadPhoneViewer } from '@/lib/call-center/lead-phones'
import { CalendarPlanner } from './calendar-planner'

const NEXT_HOURS_MS = 3 * 3_600_000

function visitVM(v: CalendarVisit): VisitVM {
  return {
    id: v.id,
    leadId: v.leadId,
    name: v.name,
    last4: v.last4,
    language: v.language,
    repKey: v.repKey,
    startsAt: v.startsAt.toISOString(),
    endsAt: v.endsAt.toISOString(),
    status: v.status,
    note: v.note,
  }
}

function railVM(lead: RailLead): RailLeadVM {
  return { id: lead.id, name: lead.name, last4: lead.last4, language: lead.language, at: lead.at.toISOString() }
}

/**
 * The dialer's Booked section (`/call-center?s=booked`; the old `?tab=calendar` still lands here,
 * docs/CALENDAR.md). Door 2 leads only, separate from the Master Calendar.
 * The view, day and rep live in the URL; everything shown is read here.
 */
export async function CallCenterCalendarTab({
  organizationId,
  params,
  viewer,
}: {
  organizationId: string
  params: Record<string, string | string[] | undefined>
  /** Who is looking: full numbers only for the leads they may see (lead-phones.ts). */
  viewer?: LeadPhoneViewer
}) {
  const now = new Date()
  const reps = calendarReps()
  const state = parseCalendarParams(params, now, reps.map((r) => r.key))
  const range = rangeFor(state.view, state.date)
  const repFilter = { repKey: state.rep, now }
  const [visits, upcoming, toSchedule, followUps, scheduler] = await Promise.all([
    listSlotsBetween(organizationId, range.from, range.to, repFilter),
    listSlotsBetween(organizationId, now, new Date(now.getTime() + NEXT_HOURS_MS), repFilter),
    listToSchedule(organizationId),
    listFollowUps(organizationId, now),
    schedulerInputs(organizationId, now),
  ])
  const repVMs = reps.map((r) => ({ key: r.key, label: r.label, color: repColor(r.key, reps) }))
  const phones = viewer
    ? await leadPhonesFor(viewer, [...visits, ...upcoming].map((v) => v.leadId).concat([...toSchedule, ...followUps].map((l) => l.id)))
    : new Map()
  const visitRow = (v: CalendarVisit): VisitVM => ({ ...visitVM(v), phone: phones.get(v.leadId) ?? null })
  const railRow = (lead: RailLead): RailLeadVM => ({ ...railVM(lead), phone: phones.get(lead.id) ?? null })

  const vm: CalendarVM = {
    ...state,
    now: now.toISOString(),
    reps: repVMs,
    visits: visits.map(visitRow),
    nextHours: upcoming.filter((v) => isLive(v.status)).map(visitRow),
    toSchedule: toSchedule.map(railRow),
    followUps: followUps.map(railRow),
    scheduler: {
      now: now.toISOString(),
      reps: repVMs,
      busy: scheduler.busy.map((b) => ({ repKey: b.repKey, startsAt: b.startsAt.toISOString() })),
      hours: scheduler.hours,
    },
  }
  return <CalendarPlanner vm={vm} />
}
