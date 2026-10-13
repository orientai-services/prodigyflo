import 'server-only'
import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import { teamChatCounts } from '@/lib/chat-bridge/remote'
import type { SessionUser } from '@/lib/rbac'
import { dayKey } from './cadence'
import { countUnreadMessages } from './messages'
import { ZONE } from './model'
import { READY_WINDOW_MS } from './team'

/**
 * A cheap fingerprint of what the dialer's desk sections (Today, Leads, Team)
 * render, for the 20 s live refresh (docs/DIALER_APP.md): when it has not
 * moved since the last check, the page is not re-read.
 *
 * It covers, for the viewer's workspace: the leads (any update), their trail
 * lines (new ones, and texts marked read), visit holds, the people (names,
 * roles, photos), who is ready on the phone (the same 2-minute rule as the
 * Team list, so a heartbeat alone does not count as a change), the unread
 * texts and team chat counts, and the phone setup the owner sees (calls,
 * numbers, connectors, carrier state, settings), plus today's date. Anything
 * outside it (a role's permissions, a carrier error ageing out of the 7-day
 * window) is caught by the full re-read the client still does every
 * FULL_REFRESH_MS (use-desk-version.ts).
 *
 * One SQL round trip plus the two badge reads; aggregates only, no row data.
 */
export async function deskVersion(user: SessionUser, now = new Date()): Promise<string> {
  const readySince = new Date(now.getTime() - READY_WINDOW_MS)
  const [rows, sms, chat] = await Promise.all([
    db.$queryRaw<Record<string, string | null>[]>`
      SELECT
        (SELECT count(*)::text || '|' || coalesce(max("updatedAt")::text, '') FROM "CallCenterLead" WHERE "organizationId" = ${user.organizationId}) AS leads,
        (SELECT count(*)::text || '|' || coalesce(max(e."createdAt")::text, '') || '|' || count(e."readAt")::text || '|' || coalesce(max(e."readAt")::text, '')
           FROM "CallCenterEvent" e JOIN "CallCenterLead" l ON l."id" = e."leadId" WHERE l."organizationId" = ${user.organizationId}) AS events,
        (SELECT count(*)::text || '|' || coalesce(max("updatedAt")::text, '') FROM "CallCenterSlot" WHERE "organizationId" = ${user.organizationId}) AS slots,
        (SELECT count(*)::text || '|' || coalesce(max("updatedAt")::text, '') FROM "User" WHERE "organizationId" = ${user.organizationId}) AS users,
        (SELECT coalesce(string_agg("userId", ',' ORDER BY "userId"), '') FROM "VoicePresence"
           WHERE "organizationId" = ${user.organizationId} AND "state" = 'ready' AND "lastSeenAt" >= ${readySince}) AS ready,
        (SELECT count(*)::text || '|' || coalesce(max("updatedAt")::text, '') FROM "VoiceCall") AS calls,
        (SELECT count(*)::text || '|' || coalesce(max("updatedAt")::text, '') FROM "PhoneNumber") AS numbers,
        (SELECT count(*)::text || '|' || coalesce(max("updatedAt")::text, '') FROM "Connector") AS connectors,
        (SELECT coalesce(max("updatedAt")::text, '') FROM "TelephonyAccountState") AS account,
        (SELECT coalesce(max("updatedAt")::text, '') FROM "Organization") AS orgs`,
    countUnreadMessages(user, now),
    teamChatCounts(user).catch(() => null),
  ])
  const parts = {
    db: rows[0] ?? null,
    sms,
    chat,
    day: dayKey(now, ZONE),
    viewer: [user.id, user.role, user.name, user.nickname ?? null, user.avatarUrl, [...user.permissions].sort()],
  }
  return createHash('sha1').update(JSON.stringify(parts)).digest('base64url')
}
