import type { Metadata } from 'next'
import { CallCenter, type CallCenterPhone } from '@/components/call-center/call-center'
import { HistorySection } from '@/components/call-center/history/history-section'
import { MessagesSection, unreadMessageCount } from '@/components/call-center/messages/messages-section'
import { teamChatCountsOnce } from '@/lib/chat-bridge/remote'
import { ADS_BASE, HISTORY_BASE, MESSAGES_BASE, resolveRoute } from '@/lib/call-center/app-shell'
import { missingRelation } from '@/lib/call-center/desk'
import { leadIdParam } from '@/lib/call-center/lead-link'
import { loadCallCenterDesk } from '@/lib/call-center/load-leads'
import { loadTeamToday, loadTodayStats } from '@/lib/call-center/team'
import { can, requireUser } from '@/lib/rbac'
import { getTwilioStatus, getVoiceSetup, listMissedCalls } from '@/lib/telephony/actions'
import type { MissedCallVM, TwilioStatusVM, VoiceSetup } from '@/lib/telephony/voice-contract'
import { loadPhoneSetup } from '@/lib/telephony/ui/phone-setup-data'
import { MetaAdsContent } from '@/app/(app)/marketing/meta/dashboard'
import { calendarEnabled } from '@/lib/call-center/calendar/config'
import { CallCenterCalendarTab } from '@/components/call-center/calendar/calendar-tab'
import { profileName } from '@/lib/people/profile-name'

export const metadata: Metadata = { title: 'Call Center' }
// `viewport-fit=cover` and the theme colour now come from the root layout for
// every page (src/lib/pwa/app-chrome.ts), so the dialer's bars read the real
// safe-area insets wherever the app is opened.
export const dynamic = 'force-dynamic'

/** `?missed=` is a VoiceCall cuid. */
function one(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value
  return v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null
}

/** A side read that must not take the desk down: an unmigrated table reads as empty, anything else is logged. */
async function soft<T>(read: Promise<T>, what: string): Promise<T | null> {
  try {
    return await read
  } catch (err) {
    if (!missingRelation(err)) console.error(`[call-center] ${what} failed`, err)
    return null
  }
}

/**
 * A slot rendered ahead of time. React reports its failure where it renders
 * (the error boundary, as before); the no-op catch only keeps a failure that
 * lands while the desk is still loading from counting as unhandled.
 */
function started<T>(render: Promise<T>): Promise<T> {
  render.catch(() => {})
  return render
}

/**
 * The dialer app (docs/DIALER_APP.md): one route, sections under `?s=`
 * (Today, Messages, Leads, Booked, History, Team). The desk's leads load on
 * every section (badges, power mode, the wrap-up); each section's own server
 * slot loads only when that section is open.
 *
 * Real Call Center rows when any exist. Dummy seed when the table is empty.
 * The phone context loads beside the desk and never takes it down: a carrier
 * or settings read that fails leaves the desk working with the `tel:` flow
 * and an empty Missed list.
 */
export default async function CallCenterPage({ searchParams }: PageProps<'/call-center'>) {
  const user = await requireUser()
  const params = await searchParams
  const owner = user.role === 'SUPER_ADMIN'
  // The Meta Ads dashboard opens from More › Campaigns, inside Leads, so the
  // ad numbers sit next to the leads they produced. Its views keep their own
  // ?view=/?w= and link back here (docs/META_ADS_SCS.md).
  const adsAllowed = can(user, 'connectors:read')
  // Call Center Calendar (flag CALL_CENTER_CALENDAR, default off): the Booked
  // section shows the planner when it is on (docs/CALENDAR.md).
  const calendarOn = calendarEnabled()
  const route = resolveRoute(params, { adsAllowed })
  const now = new Date()

  // Only the open section's server slot renders. It is started here, before
  // the desk is awaited, so its reads run beside the desk's rather than after
  // them (an async server component called directly is a promise React can
  // render as a node).
  let slot: React.ReactNode = null
  if (route.section === 'history') slot = started(HistorySection({ user, params, base: HISTORY_BASE }))
  else if (route.section === 'messages') slot = started(MessagesSection({ user, params, base: MESSAGES_BASE }))
  else if (route.ads) slot = started(MetaAdsContent({ user, params, base: ADS_BASE, embedded: true }))
  else if (route.section === 'booked' && calendarOn) slot = started(CallCenterCalendarTab({ organizationId: user.organizationId, params, viewer: user }))

  // The team chat lives on another server (the chat Worker), so its counts
  // are never awaited here: the promise streams to the shell after the page
  // (use-chat-host.ts), and a slow or unreachable chat no longer holds up the
  // desk or the 20 s refresh.
  const teamChat = teamChatCountsOnce(user)

  const [desk, voice, missed, setup, status, sms, stats, team] = await Promise.all([
    // The lead open in the URL keeps its whole trail; the rest carry what the list reads.
    loadCallCenterDesk({ fullFor: leadIdParam(params.lead), now }),
    getVoiceSetup().catch((): VoiceSetup => ({ ready: false, reason: "Phone calling isn't set up yet." })),
    listMissedCalls().catch(() => [] as MissedCallVM[]),
    owner ? loadPhoneSetup(user).catch(() => null) : Promise.resolve(null),
    owner ? getTwilioStatus(false).catch(() => null) : Promise.resolve(null),
    // Lead texts; with the streamed team chat they make one Messages badge (the shell keeps both live between
    // renders, use-chat-host.ts). The chat answer also brings each lead's case-chat unread for the lead panel.
    unreadMessageCount(user).catch(() => 0),
    route.section === 'today' ? soft(loadTodayStats(user, now), 'today stats') : Promise.resolve(null),
    route.section === 'today' || route.section === 'team' ? soft(loadTeamToday(user, now), 'team today') : Promise.resolve(null),
  ])
  // The header's profile picture. The session row is read fresh on every request (name, nickname and photo), so a
  // name saved a moment ago shows without a second read.
  const profile = {
    name: user.name,
    nickname: user.nickname ?? null,
    email: user.email,
    role: user.roleName,
    avatarUrl: user.avatarUrl,
  }
  const shownName = profileName(profile) ?? 'You'

  const phone: CallCenterPhone = {
    voiceNote: voice.ready ? null : voice.reason,
    missed: Array.isArray(missed) ? missed : [],
    openMissedId: one(params.missed),
    // Lead ids may be Meta ids ('meta:<org>:<leadgen>').
    openLeadId: leadIdParam(params.lead),
    canOverrideHours: can(user, 'telephony:manage'),
    canManageSunoff: owner,
    setup: setup
      ? { vm: setup, status: status && 'account' in status ? (status as TwilioStatusVM) : null }
      : null,
  }

  return (
    <CallCenter
      initialLeads={desk.leads}
      viewerId={desk.viewerId}
      phone={phone}
      // The Today ranking depends on the clock; the client starts from this one.
      renderedAt={now.toISOString()}
      route={route}
      adsAllowed={adsAllowed}
      calendarAllowed={calendarOn}
      slot={slot}
      unread={sms}
      unreadSplit={{ sms, team: 0, teamChat }}
      today={route.section === 'today' ? { stats, feed: team?.feed ?? null, count: team?.count ?? 0 } : null}
      team={route.section === 'team' ? (team?.members ?? []) : null}
      viewer={{ name: shownName, role: user.roleName }}
      profile={profile}
      threadOpen={route.section === 'messages' && Boolean(params.t)}
      openPad={params.pad === '1'}
    />
  )
}
