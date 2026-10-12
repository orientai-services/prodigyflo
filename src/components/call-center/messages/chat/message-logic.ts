import type { Lang, Me, Message, MemberView, Person } from './types'

/**
 * Pure rules for the message list and the composer, ported from the SunOff
 * chat web client (sunoff-chat public/index.html) so both front doors behave
 * the same. No DOM, no React: unit-tested in message-logic.test.ts.
 */

const fold = (s: string) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export const QUICK = ['👍', '✅', '🔥', '🙏', '😂', '❤️'] as const
/** The full reaction / composer picker: SunOff's list verbatim, same order (61 emoji; the contract's "62" is a miscount). */
export const EMOJI = [
  '👍', '✅', '🔥', '🙏', '😂', '❤️', '👏', '💪', '🎉', '😀', '😃', '😄', '😁', '😊', '🙂', '😉', '😍', '🤩', '😎', '🤔', '😅', '😬', '😮', '😢', '😭', '😡', '🤝', '👌', '✌️', '👋', '🙌',
  '👀', '💯', '⭐', '⚡', '☀️', '🌞', '🔆', '🏠', '🏡', '📞', '📱', '📅', '⏰', '📍', '🚗', '📝', '📄', '📎', '💰', '💵', '📈', '🏆', '🎯', '✍️', '❗', '❓', '⚠️', '❌', '🚫', '👇',
] as const

export const MAX_BODY = 4000
export const SMS_MAX_BODY = 1500
export const COUNTER_FROM = 3500
export const MAX_FILES = 10
export const MAX_FILE = 8 * 1024 * 1024
export const IMG_MAX_BYTES = 1.5e6
export const IMG_MAX_DIM = 2560
export const REC_MAX = 300
export const REC_MIN = 0.7
/** Channels over this size carry no read markers (the Worker stops listing members there too). */
export const RECEIPTS_MAX_MEMBERS = 200
export const EDIT_WINDOW_MS = 86_400_000
export const GROUP_MS = 5 * 60_000
/** What the 📎 picker offers; HEIC from iPhones goes up as is (the Worker sniffs it). */
export const ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif,.heic,.heif,application/pdf'

// ── Message text ─────────────────────────────────────────────────────────────

/** A short run of emoji only (no digits or #/* keycaps alone) shows big. */
export function isJumbo(s: string | null | undefined): boolean {
  const v = String(s ?? '').trim()
  if (!v || v.length > 16) return false
  return /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(v) && !/^[\d#*\s]+$/.test(v)
}

export type Seg = { kind: 'text'; text: string } | { kind: 'link'; href: string; text: string } | { kind: 'mention'; text: string; me: boolean }

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi
export const EVERYONE = ['todos', 'all', 'canal', 'channel'] as const

/**
 * Splits a message into text, links and @mentions. A mention is "@" + a known
 * name (longest first) or one of the everyone words; mine is marked. Text is
 * never parsed as HTML: React renders each piece as a text node.
 */
export function segments(body: string, names: readonly string[], meName: string): Seg[] {
  const src = String(body ?? '')
  const known = [...new Set([...names, meName].filter((n) => n && n.length > 1))].sort((a, b) => b.length - a.length)
  const alt = known.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).concat([...EVERYONE])
  const mre = new RegExp(`@(${alt.join('|')})(?![\\p{L}\\p{N}])`, 'gu')
  const out: Seg[] = []
  const pushText = (s: string) => {
    if (!s) return
    let last = 0
    for (const m of s.matchAll(mre)) {
      if (m.index! > last) out.push({ kind: 'text', text: s.slice(last, m.index) })
      const n = m[1]
      out.push({ kind: 'mention', text: `@${n}`, me: n === meName || (EVERYONE as readonly string[]).includes(n) })
      last = m.index! + m[0].length
    }
    if (last < s.length) out.push({ kind: 'text', text: s.slice(last) })
  }
  let last = 0
  for (const x of src.matchAll(URL_RE)) {
    pushText(src.slice(last, x.index))
    out.push({ kind: 'link', href: x[0], text: x[0] })
    last = x.index! + x[0].length
  }
  pushText(src.slice(last))
  return out
}

// ── Read state ───────────────────────────────────────────────────────────────

/** Who else has read up to (or past) a message, and whether that is everyone else in the chat. */
export function seenOf(reads: Record<string, string>, msgId: string, meUid: string, memberCount: number): { who: string[]; all: boolean } {
  const who = Object.entries(reads)
    .filter(([u, r]) => u !== meUid && r && r >= msgId)
    .map(([u]) => u)
  return { who, all: who.length > 0 && who.length >= Math.max(1, (memberCount || 2) - 1) }
}

const isLocal = (m: Message) => m.id.startsWith('m_~') || m.id.startsWith('tmp_')

/** ✓ / ✓✓ on one of my messages: null when it carries none (not mine, not sent yet, an SMS, or a big channel). */
export function tickFor(m: Message, reads: Record<string, string>, meUid: string, memberCount: number): null | { double: boolean; all: boolean } {
  if (m.uid !== meUid || m.pending || m.failed || m.deleted || m.client || isLocal(m) || memberCount > RECEIPTS_MAX_MEMBERS) return null
  const s = seenOf(reads, m.id, meUid, memberCount)
  return { double: s.who.length > 0, all: s.all }
}

/** My newest sent message: the one that gets the "Sent / Seen / Seen by" line. */
export function receiptTarget(list: Message[], meUid: string, memberCount: number): Message | null {
  if (memberCount > RECEIPTS_MAX_MEMBERS) return null
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m.uid === meUid && !m.pending && !m.failed && !isLocal(m) && !m.deleted && !m.client) return m
  }
  return null
}

export type ReceiptWords = { sent: string; seen: string; seenAll: string; seenByNames: (names: string) => string; andMore: (n: number) => string }

/** The line under my newest message: Sent, Seen (a DM), Seen by everyone (big groups), or Seen by A, B and n more. */
export function receiptText(kind: string, names: string[], all: boolean, w: ReceiptWords): string {
  if (!names.length) return w.sent
  if (kind === 'dm') return w.seen
  if (all && names.length > 3) return w.seenAll
  return w.seenByNames(names.length > 3 ? `${names.slice(0, 3).join(', ')} ${w.andMore(names.length - 3)}` : names.join(', '))
}

// ── Grouping and the "New" line ──────────────────────────────────────────────

/** Same author, same side (team vs client SMS), under 5 minutes apart, neither a system line, previous not failed. */
export function groupsWith(prev: Message | null, m: Message): boolean {
  return Boolean(
    prev &&
      prev.uid === m.uid &&
      !prev.deleted &&
      !prev.failed &&
      prev.kind !== 'system' &&
      m.kind !== 'system' &&
      Boolean(prev.client) === Boolean(m.client) &&
      m.created_at - prev.created_at < GROUP_MS,
  )
}

/**
 * Where the "New" line goes when a conversation opens: the first message from
 * someone else after my read marker; without a marker, `unread` messages from
 * the end. Null when there is nothing new.
 */
export function dividerId(list: Message[], lastRead: string | null, unread: number, meUid: string): string | null {
  if (lastRead) return list.find((m) => m.id > lastRead && m.uid !== meUid && m.kind !== 'system' && !m.pending)?.id ?? null
  if (unread > 0) {
    const others = list.filter((m) => m.uid !== meUid)
    return others[Math.max(0, others.length - unread)]?.id ?? null
  }
  return null
}

/** "5 minutes ago", "hace 2 horas", … for "last reply". */
export function relTime(ts: number, lang: Lang, now = Date.now()): string {
  const s = (now - ts) / 1000
  const f = new Intl.RelativeTimeFormat(lang === 'es' ? 'es-MX' : 'en-US', { numeric: 'auto' })
  if (s < 60) return f.format(0, 'second')
  if (s < 3600) return f.format(-Math.round(s / 60), 'minute')
  if (s < 86400) return f.format(-Math.round(s / 3600), 'hour')
  return f.format(-Math.round(s / 86400), 'day')
}

// ── Who may do what (mirrors sunoff-chat src/perm.ts; the Worker still decides) ──

/** Author within 24 h, or staff. Client SMS lines are never edited: the text already went out. */
export function canEditMessage(m: Message, me: Pick<Me, 'uid' | 'staff'>, now = Date.now()): boolean {
  if (m.deleted || m.pending || m.failed || m.kind === 'system' || m.client) return false
  return me.staff || (m.uid === me.uid && now - m.created_at <= EDIT_WINDOW_MS)
}

/** Author unless the message was flagged, or staff. */
export function canDeleteMessage(m: Message, me: Pick<Me, 'uid' | 'staff'>): boolean {
  if (m.deleted || m.pending || m.failed) return false
  return me.staff || (m.uid === me.uid && !m.flagged)
}

/** Staff or the channel's creator; thread roots only. */
export function canPinMessage(m: Message, me: Pick<Me, 'uid' | 'staff'>, createdBy: string | null | undefined): boolean {
  if (m.deleted || m.pending || m.failed || m.parent_id) return false
  return me.staff || (!!createdBy && createdBy === me.uid)
}

// ── Composer ────────────────────────────────────────────────────────────────

/** "3712/4000" past 3,500 characters; `over` past 4,000. */
export function counter(len: number): { text: string; over: boolean } {
  return { text: len > COUNTER_FROM ? `${len}/${MAX_BODY}` : '', over: len > MAX_BODY }
}

/** One draft per person and conversation (team mode of the main composer). */
export function draftKey(uid: string, channel: string): string {
  return `pf_chat_draft:${uid}:${channel}`
}

/** Phones send with the button; Enter is a new line there. */
export function enterSends(e: { key: string; shiftKey: boolean; isComposing?: boolean }, phone: boolean): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.isComposing && !phone
}

export type MentionItem = { uid: string; name: string; role?: string; online?: boolean; special?: boolean }

/**
 * The @mention list: the channel's members (the Worker lists them up to 200),
 * the directory when it doesn't, then authors seen in the conversation; never
 * me. Staff also get the everyone words outside DMs. At most 8 people.
 */
export function mentionItems(o: {
  q: string
  members: MemberView[]
  directory: Person[] | null
  authors: Array<{ uid: string; name: string }>
  meUid: string
  staff: boolean
  kind: string
  lang: Lang
}): MentionItem[] {
  const q = fold(o.q).trim()
  const pool = new Map<string, MentionItem>()
  for (const u of o.members) pool.set(u.uid, { uid: u.uid, name: u.name, role: u.role, online: u.online })
  if (!o.members.length) for (const u of o.directory ?? []) if (!pool.has(u.uid)) pool.set(u.uid, { uid: u.uid, name: u.name, role: u.role, online: u.online })
  for (const a of o.authors) if (a.uid && !pool.has(a.uid)) pool.set(a.uid, { uid: a.uid, name: a.name })
  pool.delete(o.meUid)
  const hit = (name: string) => {
    const n = fold(name)
    return !q || n.startsWith(q) || n.split(/\s+/).some((w) => w.startsWith(q))
  }
  let items = [...pool.values()].filter((u) => u.name && hit(u.name)).slice(0, 8)
  if (o.staff && o.kind !== 'dm') {
    const words = q ? EVERYONE.filter((w) => w.startsWith(q)) : [o.lang === 'es' ? 'todos' : 'all']
    items = [...words.map((w) => ({ uid: '*', name: w, special: true })), ...items]
  }
  return items
}

/** The uids to send as explicit mentions: picks whose "@Name" is still in the text ('*' for an everyone word). */
export function pickedMentions(body: string, picked: Map<string, string>): string[] {
  return [...picked].filter(([, name]) => body.includes(`@${name}`)).map(([uid]) => uid)
}

/** "@ma" right before the caret, allowing a space inside a name ("@Ana Ma"); null when the caret isn't in a mention. */
export function mentionAt(text: string, caret: number): { q: string; start: number } | null {
  const before = text.slice(0, caret)
  const m = /(^|\s)@([\p{L}\p{N}._ -]{0,30})$/u.exec(before)
  if (!m || m[2].includes('  ')) return null
  return { q: m[2], start: caret - m[2].length - 1 }
}

// ── Files ───────────────────────────────────────────────────────────────────

/** Photos (incl. HEIC with an empty type, as some browsers report) or PDF. */
export function isAllowedFile(type: string, name: string): boolean {
  if (type === 'application/pdf') return true
  if (/^image\//.test(type)) return true
  return !type && /\.(heic|heif)$/i.test(name)
}

/** Only these are redrawn on a canvas (GIF would lose its animation; HEIC can't be decoded everywhere). */
export function recompressible(type: string): boolean {
  return /^image\/(png|jpeg|webp)$/.test(type)
}

/** Small enough already: under 1.5 MB and 2560 px on the long side. */
export function fitsAlready(size: number, w: number, h: number): boolean {
  return size <= IMG_MAX_BYTES && Math.max(w, h) <= IMG_MAX_DIM
}

/** Width and height when the long side is `dim`. */
export function scaled(w: number, h: number, dim: number): { w: number; h: number } {
  const s = dim / Math.max(w, h)
  return { w: Math.round(w * s), h: Math.round(h * s) }
}

/** The next try after a JPEG came out too big: lower quality by 0.1 while it is over 0.62, then shrink by a fifth. */
export function nextAttempt(a: { dim: number; q: number }): { dim: number; q: number } {
  return a.q > 0.62 ? { dim: a.dim, q: Math.round((a.q - 0.1) * 100) / 100 } : { dim: Math.round(a.dim * 0.8), q: a.q }
}

export function firstAttempt(w: number, h: number): { dim: number; q: number } {
  return { dim: Math.min(IMG_MAX_DIM, Math.max(w, h)), q: 0.85 }
}

export function fmtSize(b: number): string {
  return b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`
}

// ── Voice ───────────────────────────────────────────────────────────────────

/** 40 bars for the player: the loudest sample per slice, scaled 0–9 against the loudest overall. */
export function waveOf(samples: number[], n = 40): string {
  const sm = samples.length ? samples : [0]
  const mx = Math.max(0.05, ...sm)
  let w = ''
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * sm.length) / n)
    const b = Math.max(a + 1, Math.floor(((i + 1) * sm.length) / n))
    w += Math.min(9, Math.round((Math.max(...sm.slice(a, b)) / mx) * 9))
  }
  return w
}

/** 32 bar heights in px for a player; without a stored wave, a steady pseudo-random strip seeded by the id. */
export function waveBars(wave: string | null | undefined, key: string, n = 32): number[] {
  const src = /^[0-9]+$/.test(wave ?? '') ? (wave as string) : ''
  let h = 0
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) | 0
  return Array.from({ length: n }, (_, i) => {
    let v: number
    if (src) v = Number(src[Math.floor((i * src.length) / n)])
    else {
      h = (h * 1103515245 + 12345) | 0
      v = 2 + ((Math.abs(h) >> 8) % 6)
    }
    return Math.max(3, Math.round(4 + v * 2.9))
  })
}

export const RATES = [1, 1.5, 2] as const
export function readRate(raw: string | null | undefined): number {
  const n = Number(raw)
  return (RATES as readonly number[]).includes(n) ? n : 1
}
export function nextRate(r: number): number {
  const i = (RATES as readonly number[]).indexOf(r)
  return RATES[(i + 1) % RATES.length]
}

/** "voz-20261012-153045.webm", like SunOff. */
export function voiceFileName(d: Date, type: string): string {
  const ty = type.split(';')[0]
  const ext = /mp4|aac|m4a/.test(ty) ? 'm4a' : /ogg/.test(ty) ? 'ogg' : 'webm'
  const p = (n: number) => String(n).padStart(2, '0')
  return `voz-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`
}

/** RMS loudness of one analyser frame, 0–1 (×3.2 so speech fills the meter). */
export function levelOf(frame: ArrayLike<number>): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) {
    const x = (frame[i] - 128) / 128
    sum += x * x
  }
  return Math.min(1, Math.sqrt(sum / Math.max(1, frame.length)) * 3.2)
}
