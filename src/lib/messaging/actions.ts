'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { ForbiddenError, requireUser } from '@/lib/rbac'
import { sendMessage, type SendOutcome } from './send'

const sendSchema = z
  .object({
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
      .object({
        dueAt: z.coerce.date().refine((d) => !Number.isNaN(d.getTime()), 'Invalid due date'),
        title: z.string().max(200).optional(),
      })
      .optional(),
  })
  .refine((v) => Boolean(v.templateId) || Boolean(v.body?.trim()), {
    message: 'Pick a template or write a message.',
    path: ['body'],
  })

export async function sendMessageAction(raw: unknown): Promise<SendOutcome> {
  const parsed = sendSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return { ok: false, code: 'VALIDATION', error: first ? `${first.path.join('.')}: ${first.message}` : 'Invalid input.' }
  }

  const user = await requireUser()
  try {
    const outcome = await sendMessage(user, parsed.data)
    if (outcome.ok) revalidatePath(`/clients/${parsed.data.clientId}`)
    return outcome
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, code: 'FORBIDDEN', error: err.message }
    throw err
  }
}
