import 'server-only'
import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import { getEmailProvider, isMockMode } from '@/lib/messaging'
import { recordAudit } from '@/lib/audit'
import { linkedSunoffIdById } from './link'

/**
 * The team chat's fallback notice for ProdigyFlo-only people
 * (docs/TEAM_CHAT_PARITY.md F4, sunoff-chat docs/CHAT_CONTRACT.md §7):
 *
 *   POST /api/bridge/chat/notify {uid, pf_user_id, title, body, url, count, lang}  (signed with PF_CHAT_KEY)
 *   → {ok:true, sent:boolean}
 *
 * The chat Worker calls it when someone's unread messages have waited over
 * 10 minutes and no device of theirs was reached. ProdigyFlo checks that the
 * PF user still links to that SunOff uid, then sends ONE email from its own
 * mail path: a count, the Worker's ≤140-character summary (never message
 * text beyond it), and a button to the conversation. At most one per person
 * per 3 hours (counted from this route's own audit rows). Every email is
 * audited as `chat.fallback_notice` with counts and the result only.
 */

export const NOTICE_EVERY_MS = 3 * 3600_000
export const PREVIEW_MAX = 140
export const PF_CHAT_HOME = 'https://www.prodigyflo.ai/call-center?s=messages'
const AUDIT_ACTION = 'chat.fallback_notice'

export type ChatNoticeInput = { uid: string; pf_user_id: string; title: string; body: string; url: string; count: number; lang: 'en' | 'es' }
export type ChatNoticeResult =
  | { status: 200; body: { ok: true; sent: boolean; reason?: 'recent' | 'mock' | 'failed' } }
  | { status: 400 | 403 | 409; body: { ok: false; error: string; message: string } }

const clean = (v: string, max: number) => v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

export function parseChatNotice(raw: unknown): ChatNoticeInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.uid !== 'string' || !/^u\d{1,12}$/.test(r.uid)) return null
  if (typeof r.pf_user_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r.pf_user_id)) return null
  if (typeof r.body !== 'string' || !r.body.trim()) return null
  const count = Math.floor(Number(r.count))
  const title = typeof r.title === 'string' ? clean(r.title, 80) : ''
  // The Worker sends the person's `lang` (contract §14); an older Worker without it is read from its title.
  const lang = r.lang === 'es' || r.lang === 'en' ? r.lang : /^chat del equipo/i.test(title) ? 'es' : 'en'
  return {
    uid: r.uid,
    pf_user_id: r.pf_user_id,
    title,
    body: clean(r.body, PREVIEW_MAX),
    url: safeChatUrl(r.url),
    count: Number.isFinite(count) && count > 0 ? Math.min(count, 999) : 1,
    lang,
  }
}

/** Links only ever point at ProdigyFlo's own site; anything else becomes the Team chat home. */
export function safeChatUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 500) return PF_CHAT_HOME
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && u.hostname === 'www.prodigyflo.ai' && !u.username && !u.password && !u.port ? u.toString() : PF_CHAT_HOME
  } catch {
    return PF_CHAT_HOME
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

export function buildNoticeEmail(n: Pick<ChatNoticeInput, 'count' | 'body' | 'url' | 'lang'>): { subject: string; text: string; html: string } {
  const es = n.lang === 'es'
  const subject = es
    ? `${n.count} ${n.count === 1 ? 'mensaje sin leer' : 'mensajes sin leer'} en el chat del equipo`
    : `${n.count} unread in Team chat`
  const button = es ? 'Abrir el chat del equipo' : 'Open Team chat'
  const why = es
    ? 'Le llega este correo cuando hay mensajes esperando más de 10 minutos y ningún dispositivo suyo recibió el aviso. Como máximo uno cada 3 horas. Active los avisos en Mensajes › Chat del equipo para recibirlos en su teléfono.'
    : 'You get this when team chat messages wait more than 10 minutes and none of your devices was reached. At most one every 3 hours. Turn on notifications in Messages › Team chat to get them on your phone instead.'
  const text = `${n.body}\n\n${button}: ${n.url}\n\n${why}`
  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1d21;">
    <div style="max-width:480px;margin:0 auto;padding:32px 20px;">
      <div style="font-size:18px;font-weight:700;letter-spacing:-0.02em;margin-bottom:20px;">Prodigy<span style="color:#0e6b66;">Flo</span></div>
      <div style="background:#ffffff;border:1px solid #e4e6ea;border-radius:12px;padding:28px;">
        <h1 style="margin:0 0 8px;font-size:18px;font-weight:600;">${esc(subject)}</h1>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#4b5158;">${esc(n.body)}</p>
        <a href="${esc(n.url)}" style="display:inline-block;background:#0e6b66;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 20px;border-radius:8px;">${esc(button)}</a>
        <p style="margin:20px 0 0;font-size:12px;line-height:1.6;color:#7a8088;">${esc(why)}</p>
      </div>
    </div>
  </body>
</html>`
  return { subject, text, html }
}

/** The signature, hashed: what an audit row keeps to refuse a replayed request. */
export function signatureKey(sig: string): string {
  return createHash('sha256').update(sig, 'utf8').digest('hex').slice(0, 32)
}

const refuse = (status: 400 | 403 | 409, error: string, message: string): ChatNoticeResult => ({ status, body: { ok: false, error, message } })

export async function sendChatNotice(input: ChatNoticeInput, signature: string, now = new Date()): Promise<ChatNoticeResult> {
  const link = await linkedSunoffIdById(input.pf_user_id)
  if (!link || `u${link.sunoffUserId}` !== input.uid) return refuse(403, 'not_linked', 'That SunOff account isn’t linked to this ProdigyFlo user.')
  const user = link.user
  const sig = signatureKey(signature)

  const replay = await db.auditEvent.findFirst({
    where: { organizationId: user.organizationId, action: AUDIT_ACTION, after: { path: ['sig'], equals: sig } },
    select: { id: true },
  })
  if (replay) return refuse(409, 'replay', 'This request was already received.')

  const recent = await db.auditEvent.findFirst({
    where: {
      organizationId: user.organizationId,
      action: AUDIT_ACTION,
      entityId: user.id,
      createdAt: { gte: new Date(now.getTime() - NOTICE_EVERY_MS) },
      after: { path: ['sent'], equals: true },
    },
    select: { id: true },
  })
  if (recent) return { status: 200, body: { ok: true, sent: false, reason: 'recent' } }

  const mail = buildNoticeEmail(input)
  const mock = isMockMode('EMAIL')
  const result = await getEmailProvider()
    .send({ to: user.email, subject: mail.subject, body: mail.text, html: mail.html, organizationId: user.organizationId })
    .catch((e: unknown) => ({ status: 'FAILED' as const, externalRef: null, error: e instanceof Error ? e.message : 'send failed' }))
  // The mock reaches nobody: it never counts as sent, so it never holds back a real notice.
  const sent = result.status === 'SENT' && !mock
  await recordAudit(user, {
    action: AUDIT_ACTION,
    entityType: 'User',
    entityId: user.id,
    summary: sent ? 'Emailed a team chat unread notice' : mock ? 'Team chat unread notice (test mail, not delivered)' : 'Team chat unread notice email failed',
    after: { sent, count: input.count, via: 'email', mock, sig, sunoffUser: input.uid },
  }).catch(() => undefined)
  return { status: 200, body: { ok: true, sent, ...(sent ? {} : { reason: mock ? ('mock' as const) : ('failed' as const) }) } }
}
