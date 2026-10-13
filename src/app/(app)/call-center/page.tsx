import type { Metadata, Viewport } from 'next'
import { CallCenter, type CallCenterPhone } from '@/components/call-center/call-center'
import { HistorySection } from '@/components/call-center/history/history-section'
import { MessagesSection, unreadMessageCount } from '@/components/call-center/messages/messages-section'
import { teamChatCounts } from '@/lib/chat-bridge/remote'
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
import { db } from '@/lib/db'
import { profileName } from '@/lib/people/profile-name'

export const metadata: Metadata = { title: 'Call Center' }
// The dialer is an app-style page with a bottom tab bar: `cover` lets it run
// under the iPhone home indicator so env(safe-area-inset-*) reports the real
// insets (they read 0 without it), and the theme colour tints Safari's
// toolbars to the desk paper.
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#faf7f0' }
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

  const [desk, voice, missed, setup, status, unread, stats, team, me] = await Promise.all([
    loadCallCenterDesk(),
    getVoiceSetup().catch((): VoiceSetup => ({ ready: false, reason: "Phone calling isn't set up yet." })),
    listMissedCalls().catch(() => [] as MissedCallVM[]),
    owner ? loadPhoneSetup(user).catch(() => null) : Promise.resolve(null),
    owner ? getTwilioStatus(false).catch(() => null) : Promise.resolve(null),
    // Lead texts plus the team chat: one Messages badge (the shell keeps both live between renders, use-chat-host.ts).
    // One chat call per page load also brings each lead's case-chat unread for the lead panel's Team chat button.
    Promise.all([unreadMessageCount(user).catch(() => 0), teamChatCounts(user).catch(() => ({ total: 0, mentions: 0, cases: {} }))]).then(
      ([sms, chat]) => ({ sms, team: chat.total, cases: chat.cases }),
    ),
    route.section === 'today' ? soft(loadTodayStats(user, now), 'today stats') : Promise.resolve(null),
    route.section === 'today' || route.section === 'team' ? soft(loadTeamToday(user, now), 'team today') : Promise.resolve(null),
    // The header's profile picture: the session row has no nickname, and a name saved a moment ago must show.
    soft(db.user.findUnique({ where: { id: user.id }, select: { name: true, nickname: true, avatarUrl: true } }), 'profile'),
  ])
  const profile = {
    name: me?.name ?? user.name,
    nickname: me?.nickname ?? null,
    email: user.email,
    role: user.roleName,
    avatarUrl: me ? me.avatarUrl : user.avatarUrl,
  }
  const shownName = profileName(profile) ?? 'You'

  const phone: CallCenterPhone = {
    voiceNote: voice.ready ? null : voice.reason,
    missed: Array.isArray(missed) ? missed : [],
    openMissedId: one(params.missed),
    // Lead ids may be Meta ids ('meta:<org>:<leadgen>').
    openLeadId: leadIdParam(params.lead),
    canOverrideHours: can(user, 'telephony:manage'),
    setup: setup
      ? { vm: setup, status: status && 'account' in status ? (status as TwilioStatusVM) : null }
      : null,
  }

  // Only the open section's server slot renders.
  let slot: React.ReactNode = null
  if (route.section === 'history') slot = <HistorySection user={user} params={params} base={HISTORY_BASE} />
  else if (route.section === 'messages') slot = <MessagesSection user={user} params={params} base={MESSAGES_BASE} />
  else if (route.ads) slot = <MetaAdsContent user={user} params={params} base={ADS_BASE} embedded />
  else if (route.section === 'booked' && calendarOn) slot = <CallCenterCalendarTab organizationId={user.organizationId} params={params} />

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
      unread={unread.sms + unread.team}
      unreadSplit={unread}
      today={route.section === 'today' ? { stats, feed: team?.feed ?? null, count: team?.count ?? 0 } : null}
      team={route.section === 'team' ? (team?.members ?? []) : null}
      viewer={{ name: shownName, role: user.roleName }}
      profile={profile}
      threadOpen={route.section === 'messages' && Boolean(params.t)}
    />
  )
}
