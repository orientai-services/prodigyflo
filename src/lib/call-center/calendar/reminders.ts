import { clientTextEnabled } from './config'
import { calendarCopy, formatVisitTime, type CalendarLanguage } from './copy'

const HOUR = 3_600_000

export type ReminderKind = 'reminder24RepAt' | 'reminder24ClientAt' | 'reminder3RepAt' | 'reminder3ClientAt'

export type ReminderSlot = {
  id: string
  status: string
  startsAt: Date
  language: CalendarLanguage
  reminder24RepAt: Date | null
  reminder24ClientAt: Date | null
  reminder3RepAt: Date | null
  reminder3ClientAt: Date | null
}

export type ReminderJob = {
  slotId: string
  kind: ReminderKind
  to: 'rep' | 'client'
  channel: 'EMAIL' | 'SMS'
}

/**
 * Which reminders are due now. 24h and 3h before, to both rep and client.
 * Only HOLD or CONFIRMED visits get reminders. A window that already passed
 * (the visit is now closer than the next offset) is not sent late twice:
 * the 24h one is skipped once the 3h window has opened.
 */
export function dueReminders(slots: ReminderSlot[], now: Date, env: Record<string, string | undefined> = process.env): ReminderJob[] {
  const clientChannel = clientTextEnabled(env) ? 'SMS' : 'EMAIL'
  const jobs: ReminderJob[] = []
  for (const s of slots) {
    if (s.status !== 'HOLD' && s.status !== 'CONFIRMED') continue
    const left = s.startsAt.getTime() - now.getTime()
    if (left <= 0) continue
    if (left <= 3 * HOUR) {
      if (!s.reminder3RepAt) jobs.push({ slotId: s.id, kind: 'reminder3RepAt', to: 'rep', channel: 'EMAIL' })
      if (!s.reminder3ClientAt) jobs.push({ slotId: s.id, kind: 'reminder3ClientAt', to: 'client', channel: clientChannel })
    } else if (left <= 24 * HOUR) {
      if (!s.reminder24RepAt) jobs.push({ slotId: s.id, kind: 'reminder24RepAt', to: 'rep', channel: 'EMAIL' })
      if (!s.reminder24ClientAt) jobs.push({ slotId: s.id, kind: 'reminder24ClientAt', to: 'client', channel: clientChannel })
    }
  }
  return jobs
}

export function reminderMessage(job: ReminderJob, slot: { startsAt: Date; language: CalendarLanguage }, repLabel: string, leadRef: string) {
  const copy = calendarCopy(slot.language)
  const when = formatVisitTime(slot.startsAt, slot.language)
  return job.to === 'client'
    ? { subject: copy.clientSubject(when), body: copy.clientBody(when, repLabel) }
    : { subject: copy.repSubject(when), body: copy.repBody(when, leadRef) }
}
