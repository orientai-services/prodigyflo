/**
 * Shapes of the SunOff chat Worker's REST + WebSocket API as this screen uses
 * them (sunoff-chat docs/CHAT_CONTRACT.md §5, §6, §13, §14). Only the fields
 * read here are typed; the Worker may send more.
 */

export type Lang = 'en' | 'es'
export type Kind = 'main' | 'announcements' | 'team' | 'group' | 'dm'

export type Notify = 'all' | 'mentions' | 'none'

/** Quiet hours as the Worker keeps them (HH:MM, the user's own time zone). */
export type Quiet = { on: boolean; from: string; to: string }

export type MePrefs = { lang?: Lang | string | null; notify_default?: Notify | null; quiet?: Quiet; tz?: string }

export type Me = {
  uid: string
  name: string
  role: string
  staff: boolean
  super: boolean
  company_id: number
  lang: Lang
  avatar?: string | null
  team?: { id: string; name: string; badge: { emoji?: string; color?: string } | null } | null
  prefs?: MePrefs
}

/** GET /api/me. */
export type MeAnswer = { me: Me; unread_total: number; mentions: number; vapid_public: string | null; companies?: Record<string, string> }

export type MemberView = { uid: string; name: string; role: string; staff: boolean; online: boolean }

export type CaseView = {
  lead_id: string
  host: 'dialer' | 'prodigyflo'
  stage: string | null
  closed: boolean
  rep_uid: string
  rep_name: string | null
  phone4: string | null
  appt_at: number | null
  meet_uri: string | null
  dialer_url: string
  type: string | null
}

export type Channel = {
  id: string
  kind: Kind
  name: string
  read_only: boolean
  can_post: boolean
  dm_uid?: string
  unread: number
  mentions: number
  pins: number
  /** `seen`: how many other members have read up to it (the list's ✓ / ✓✓ on my last message). */
  last_msg: { id: string; uid: string; name: string; body: string; at: number; att: 'voice' | 'image' | 'file' | null; deleted: boolean; seen?: number } | null
  last_msg_at: number | null
  members: MemberView[]
  member_count: number
  muted: boolean
  notify: string
  last_read_msg_id: string | null
  case?: CaseView | null
  created_by?: string | null
  archived_at?: number | null
  company_id?: number
  badge?: { emoji?: string; color?: string } | null
  /** Socket hints: the row changed or left. */
  removed?: boolean
  refetch?: boolean
}

export type Attachment = {
  id: string
  name: string
  type: string
  size: number
  w?: number | null
  h?: number | null
  kind?: 'voice'
  duration?: number | null
  wave?: string | null
  tx?: 'pending' | 'done' | 'failed' | 'none'
  transcript?: string | null
}

export type Message = {
  id: string
  channel: string
  uid: string
  name: string
  body: string
  kind: string
  parent_id: string | null
  reply_count: number
  edited_at: number | null
  deleted: boolean
  pinned: boolean
  attachments: Attachment[]
  mentions: string[]
  reactions: Record<string, string[]>
  created_at: number
  client_id?: string | null
  client?: { dir: 'in' | 'out'; via: string } | null
  flagged?: boolean
  flag_reason?: string | null
  last_reply_at?: number | null
  /** Local only: an optimistic copy waiting for (or refused by) the server. */
  pending?: boolean
  failed?: string | null
}

export type Relation = 'staff' | 'upline' | 'downline' | 'team'
export type Person = {
  uid: string
  name: string
  role: string
  staff: boolean
  online: boolean
  relation: Relation | string
  company_id?: number
  team?: { id: string; name: string; badge: { emoji?: string } | null } | null
}

/** GET /api/flagged: the original text plus where it was posted (staff only). */
export type FlaggedAnswer = { messages: Array<Omit<Message, 'channel'> & { channel: { id: string; name: string; kind: Kind | string } }> }

/** A team video room (sunoff-chat src/rooms.ts roomOut). `live` null = unknown (Meet off or never opened). */
export type Room = {
  id: string
  name: string
  auto: boolean
  team_id: string | null
  badge: { emoji?: string } | null
  owner: { uid: string; name: string }
  people: number
  uri: string | null
  mine: boolean
  in_line: boolean
  can_manage: boolean
  last_join_at: number | null
  last_join_name: string | null
  live: { n: number; names: string[] } | null
}
export type RoomsAnswer = { rooms: Room[]; inside: number; can_create: boolean; owners: Array<{ uid: string; name: string }> }

export type SearchHit = { message: Message; channel: { id: string; kind: Kind | null; name: string }; snippet: string }

export type ChatEvent =
  | { t: 'hello'; at: number }
  | { t: 'msg'; channel: string; message: Message }
  | { t: 'edit'; channel: string; message: Message }
  | { t: 'del'; channel: string; id: string }
  | { t: 'react'; channel: string; id: string; reactions: Record<string, string[]> }
  | { t: 'pin'; channel: string; id: string; pinned: boolean }
  | { t: 'read'; channel: string; uid: string; msg_id: string }
  | { t: 'typing'; channel: string; uid: string; name: string }
  | { t: 'presence'; uid: string; online: boolean }
  | { t: 'channel'; channel: Channel }
  | { t: 'unread'; total: number; mentions: number }
  | { t: 'case'; channel: string }
  | { t: 'rooms' }
  | { t: 'batch'; evs: ChatEvent[] }
  | { t: 'pong' }
