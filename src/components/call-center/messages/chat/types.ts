/**
 * Shapes of the SunOff chat Worker's REST + WebSocket API as this screen uses
 * them (sunoff-chat docs/CHAT_CONTRACT.md §5, §6, §13, §14). Only the fields
 * read here are typed; the Worker may send more.
 */

export type Lang = 'en' | 'es'
export type Kind = 'main' | 'announcements' | 'team' | 'group' | 'dm'

export type Me = {
  uid: string
  name: string
  role: string
  staff: boolean
  super: boolean
  company_id: number
  lang: Lang
}

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
  last_msg: { id: string; uid: string; name: string; body: string; at: number; att: 'voice' | 'image' | 'file' | null; deleted: boolean } | null
  last_msg_at: number | null
  members: MemberView[]
  member_count: number
  muted: boolean
  notify: string
  last_read_msg_id: string | null
  case?: CaseView | null
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
  /** Local only: an optimistic copy waiting for (or refused by) the server. */
  pending?: boolean
  failed?: string | null
}

export type Person = { uid: string; name: string; role: string; staff: boolean; online: boolean; relation: string }

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
  | { t: 'batch'; evs: ChatEvent[] }
  | { t: 'pong' }
