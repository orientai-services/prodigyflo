'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/rbac'
import { recordAudit } from '@/lib/audit'
import { findPortalClient, PORTAL_COPY } from '@/lib/portal'
import { confirmNurtureTouchFromPortal, NurtureError } from '@/lib/nurture'

export type PortalActionResult = { ok: true } | { ok: false; error: string }

const messageSchema = z.object({
  body: z.string().trim().min(1, PORTAL_COPY.messageEmpty).max(4000, 'Please keep your message under 4,000 characters.'),
})

// Flood guard: a client should never legitimately send this fast. Counting the
// client's own recent inbound portal comms is one indexed query — no extra
// state — and every message past the limit costs an advisor notification.
const MESSAGE_BURST_LIMIT = 10
const MESSAGE_BURST_WINDOW_MS = 5 * 60_000

/**
 * The client writing to their team. Deliberately NOT sendMessage() — nothing
 * leaves the building: it records an INBOUND portal Communication on their own
 * client row and rings the owning advisor's notification bell.
 */
export async function sendPortalMessage(input: { body: string }): Promise<PortalActionResult> {
  const user = await getSessionUser()
  if (!user) return { ok: false, error: 'Please sign in again.' }

  const client = await findPortalClient(user)
  if (!client) return { ok: false, error: 'Your portal is not available right now.' }

  const parsed = messageSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? PORTAL_COPY.messageEmpty }
  }

  const recentCount = await db.communication.count({
    where: {
      clientId: client.id,
      channel: 'PORTAL_MESSAGE',
      direction: 'INBOUND',
      occurredAt: { gte: new Date(Date.now() - MESSAGE_BURST_WINDOW_MS) },
    },
  })
  if (recentCount >= MESSAGE_BURST_LIMIT) {
    return {
      ok: false,
      error: 'You are sending messages very quickly — please wait a few minutes and try again. Your team has your earlier messages.',
    }
  }

  const communication = await db.communication.create({
    data: {
      clientId: client.id,
      userId: user.id,
      channel: 'PORTAL_MESSAGE',
      direction: 'INBOUND',
      status: 'RECEIVED',
      subject: 'Portal message',
      body: parsed.data.body,
      isInternal: false,
      occurredAt: new Date(),
    },
  })

  await db.client.update({
    where: { id: client.id },
    data: { lastActivityAt: new Date() },
  })

  // Ring the advisor. If the client has no owner yet, fall back to the org's
  // admins so the message never lands in a void.
  const recipients = client.owner
    ? [client.owner.id]
    : (
        await db.user.findMany({
          where: {
            organizationId: user.organizationId,
            isActive: true,
            deletedAt: null,
            role: { key: { in: ['SUPER_ADMIN', 'ADMIN'] } },
          },
          select: { id: true },
          take: 5,
        })
      ).map((u) => u.id)

  if (recipients.length > 0) {
    await db.notification.createMany({
      data: recipients.map((userId) => ({
        organizationId: user.organizationId,
        userId,
        kind: 'MESSAGE' as const,
        title: `New portal message from ${client.firstName} ${client.lastName}`,
        body: parsed.data.body.length > 140 ? `${parsed.data.body.slice(0, 140)}…` : parsed.data.body,
        href: `/clients/${client.id}`,
      })),
    })
  }

  await recordAudit(user, {
    action: 'portal.message_sent',
    entityType: 'Communication',
    entityId: communication.id,
    summary: `Portal message from ${client.firstName} ${client.lastName} (${parsed.data.body.length} chars)`,
  })

  revalidatePath('/portal')
  return { ok: true }
}

/**
 * The client opening what their advisor sent — the real nurture confirmation.
 * All validation, auditing, and the sender's bell live in
 * confirmNurtureTouchFromPortal; this action only guards the session and
 * refreshes the page.
 */
export async function confirmPortalNurture(input: { touchId: string }): Promise<PortalActionResult> {
  const user = await getSessionUser()
  if (!user) return { ok: false, error: 'Please sign in again.' }

  const client = await findPortalClient(user)
  if (!client) return { ok: false, error: 'Your portal is not available right now.' }

  const parsed = z.object({ touchId: z.string().min(1) }).safeParse(input)
  if (!parsed.success) return { ok: false, error: 'That item is not available.' }

  try {
    await confirmNurtureTouchFromPortal(user, parsed.data.touchId)
  } catch (error) {
    if (error instanceof NurtureError) return { ok: false, error: error.message }
    throw error
  }

  await db.client.update({
    where: { id: client.id },
    data: { lastActivityAt: new Date() },
  })

  revalidatePath('/portal')
  return { ok: true }
}
