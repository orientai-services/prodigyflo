import { z } from 'zod'
import { db } from '@/lib/db'
import { can, findClientInScope, ForbiddenError, getSessionUser } from '@/lib/rbac'
import { sendMessage } from '@/lib/messaging/send'

/** Message history for one client, newest first. */
export async function GET(request: Request) {
  const user = await getSessionUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  if (!can(user, 'communications:read')) return Response.json({ error: 'Forbidden' }, { status: 403 })

  const clientId = new URL(request.url).searchParams.get('clientId')
  if (!clientId) return Response.json({ error: 'clientId is required' }, { status: 422 })

  const client = await findClientInScope(user, clientId)
  if (!client) return Response.json({ error: 'Client not found or out of scope' }, { status: 404 })

  const communications = await db.communication.findMany({
    where: { clientId: client.id, ...(can(user, 'communications:read_internal') ? {} : { isInternal: false }) },
    orderBy: { occurredAt: 'desc' },
    take: 100,
    select: {
      id: true,
      channel: true,
      direction: true,
      status: true,
      subject: true,
      body: true,
      templateKey: true,
      externalRef: true,
      occurredAt: true,
      user: { select: { name: true } },
      message: { select: { toMasked: true, failureCode: true, deliveredAt: true } },
    },
  })

  return Response.json({ communications })
}

const sendSchema = z.object({
  clientId: z.string().min(1),
  channel: z.enum(['EMAIL', 'SMS']),
  templateId: z.string().min(1).optional(),
  subject: z.string().max(300).optional(),
  body: z.string().max(10_000).optional(),
  context: z
    .object({
      appointmentId: z.string().min(1).optional(),
      documentId: z.string().min(1).optional(),
    })
    .optional(),
  followUpTask: z
    .object({ dueAt: z.coerce.date(), title: z.string().max(200).optional() })
    .optional(),
})

/**
 * Sends one outbound message. Every rule the UI relies on — permission, scope,
 * consent, strict variable resolution — is enforced here as well, so a caller
 * bypassing the composer gains nothing.
 */
export async function POST(request: Request) {
  const user = await getSessionUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const raw = await request.json().catch(() => null)
  if (!raw) return Response.json({ error: 'Invalid JSON body' }, { status: 400 })

  const parsed = sendSchema.safeParse(raw)
  if (!parsed.success) {
    const errors: Record<string, string> = {}
    for (const issue of parsed.error.issues) errors[issue.path.join('.') || '_form'] ??= issue.message
    return Response.json({ errors }, { status: 422 })
  }

  try {
    const outcome = await sendMessage(user, parsed.data)
    if (!outcome.ok) {
      // Consent and content refusals: the send did not happen.
      return Response.json(outcome, { status: 409 })
    }
    return Response.json(outcome, { status: 201 })
  } catch (err) {
    if (err instanceof ForbiddenError) return Response.json({ error: err.message }, { status: 403 })
    throw err
  }
}
