import type { NotificationKind } from '@prisma/client'
import { db } from '@/lib/db'
import { getEmailProvider, getSmsProvider, isMockMode } from '@/lib/messaging'
import { appOrigin } from './index'

/**
 * One telephony alert, delivered three ways: the in-app Notification row
 * (always), an email to each user (when the email provider is live), and a
 * text to each user who has a phone on their profile (when the SMS provider
 * is live). Delivery never throws: a carrier webhook or a sweep must finish
 * even when Resend or Twilio is down, so failures are logged and counted.
 *
 * Texts to staff need no consent record (they are the team's own alerts), but
 * they do need the account's A2P registration, so until Twilio approves it
 * every text fails with 30034 and only the email and the in-app row land.
 */

export type TeamAlert = {
  organizationId: string
  userIds: string[]
  kind: NotificationKind
  title: string
  body: string
  /** App path; the email and text carry it as a full link. */
  href: string
}

export type TeamAlertResult = { notified: number; emailed: number; texted: number }

const APP_NAME = 'ProdigyFlo'

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

export function alertEmailHtml(input: { title: string; body: string; link: string }): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1d21;">
    <div style="max-width:480px;margin:0 auto;padding:32px 20px;">
      <div style="font-size:18px;font-weight:700;letter-spacing:-0.02em;margin-bottom:20px;">Prodigy<span style="color:#0f766e;">Flo</span></div>
      <div style="background:#ffffff;border:1px solid #e4e6ea;border-radius:12px;padding:28px;">
        <h1 style="margin:0 0 8px;font-size:18px;font-weight:600;">${escapeHtml(input.title)}</h1>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#4b5158;">${escapeHtml(input.body)}</p>
        <a href="${input.link}" style="display:inline-block;background:#1a1d21;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 20px;border-radius:8px;">Open in ${APP_NAME}</a>
      </div>
      <p style="margin:16px 0 0;font-size:11px;color:#a0a4ab;">${APP_NAME} · Call Center alert. Your team's phone settings decide who gets these.</p>
    </div>
  </body>
</html>`
}

/** The text message: title, body, link. Kept short so one segment usually carries it. */
export function alertSmsText(input: { title: string; body: string; link: string }): string {
  return `${APP_NAME}: ${input.title}. ${input.body} ${input.link}`
}

export async function notifyTeam(alert: TeamAlert): Promise<TeamAlertResult> {
  const userIds = [...new Set(alert.userIds)]
  if (userIds.length === 0) return { notified: 0, emailed: 0, texted: 0 }

  await db.notification.createMany({
    data: userIds.map((userId) => ({
      organizationId: alert.organizationId,
      userId,
      kind: alert.kind,
      title: alert.title,
      body: alert.body,
      href: alert.href,
    })),
  })

  const result: TeamAlertResult = { notified: userIds.length, emailed: 0, texted: 0 }
  try {
    const link = `${appOrigin()}${alert.href}`
    const users = await db.user.findMany({
      where: { id: { in: userIds }, isActive: true, deletedAt: null },
      select: { id: true, email: true, phone: true },
    })
    const emailLive = !isMockMode('EMAIL')
    const smsLive = !isMockMode('SMS')
    await Promise.all(
      users.map(async (u) => {
        if (emailLive && u.email) {
          try {
            const r = await getEmailProvider().send({
              to: u.email,
              subject: `${alert.title} · ${APP_NAME}`,
              body: `${alert.title}\n\n${alert.body}\n\n${link}`,
              html: alertEmailHtml({ title: alert.title, body: alert.body, link }),
              organizationId: alert.organizationId,
            })
            if (r.status === 'SENT') result.emailed += 1
            else console.warn('[telephony] alert email failed', { userId: u.id, error: r.error })
          } catch (err) {
            console.warn('[telephony] alert email threw', { userId: u.id, err })
          }
        }
        if (smsLive && u.phone) {
          try {
            const r = await getSmsProvider().send({
              to: u.phone,
              body: alertSmsText({ title: alert.title, body: alert.body, link }),
              organizationId: alert.organizationId,
            })
            if (r.status === 'SENT') result.texted += 1
            else console.warn('[telephony] alert text failed', { userId: u.id, error: r.error })
          } catch (err) {
            console.warn('[telephony] alert text threw', { userId: u.id, err })
          }
        }
      }),
    )
  } catch (err) {
    // The in-app rows are already saved; delivery is best effort.
    console.warn('[telephony] alert delivery skipped', err)
  }
  return result
}
