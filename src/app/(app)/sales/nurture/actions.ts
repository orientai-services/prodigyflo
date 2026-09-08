'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { ForbiddenError, requireUser } from '@/lib/rbac'
import { NurtureError, confirmNurtureTouch, recordNurtureTouch } from '@/lib/nurture'

export type NurtureActionState = { error?: string; ok?: boolean }

function revalidateNurture(clientId: string) {
  revalidatePath('/sales/nurture')
  revalidatePath(`/clients/${clientId}`)
}

const touchSchema = z.object({
  clientId: z.string().min(1, 'Missing client.'),
  kind: z.enum(['VIDEO', 'EMAIL', 'SMS', 'CALL_PREP']),
  url: z.string().max(2048, 'That link is too long.').optional(),
  note: z.string().max(2000, 'Keep the note under 2,000 characters.').optional(),
})

export async function logNurtureTouchAction(
  _prev: NurtureActionState,
  formData: FormData,
): Promise<NurtureActionState> {
  const parsed = touchSchema.safeParse({
    clientId: formData.get('clientId'),
    kind: formData.get('kind'),
    url: formData.get('url') || undefined,
    note: formData.get('note') || undefined,
  })
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  try {
    const user = await requireUser()
    await recordNurtureTouch(user, {
      clientId: parsed.data.clientId,
      kind: parsed.data.kind,
      url: parsed.data.url ?? null,
      note: parsed.data.note ?? null,
    })
    revalidateNurture(parsed.data.clientId)
    return { ok: true }
  } catch (error) {
    if (error instanceof NurtureError || error instanceof ForbiddenError) {
      return { error: error.message }
    }
    throw error
  }
}

const confirmSchema = z.object({
  touchId: z.string().min(1, 'Missing touch.'),
})

export async function confirmNurtureTouchAction(
  _prev: NurtureActionState,
  formData: FormData,
): Promise<NurtureActionState> {
  const parsed = confirmSchema.safeParse({ touchId: formData.get('touchId') })
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  try {
    const user = await requireUser()
    const touch = await confirmNurtureTouch(user, parsed.data.touchId)
    revalidateNurture(touch.clientId)
    return { ok: true }
  } catch (error) {
    if (error instanceof NurtureError || error instanceof ForbiddenError) {
      return { error: error.message }
    }
    throw error
  }
}
