'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/rbac'
import { calendarEnabled } from './config'
import { isOutcome } from './outcomes'
import { confirmSlot, holdSlot, recordSlotOutcome } from './service'

async function actor() {
  if (!calendarEnabled()) throw new Error('Call Center Calendar is off.')
  return requireUser()
}

export async function holdCalendarSlot(form: FormData): Promise<void> {
  const user = await actor()
  const [repKey, iso] = String(form.get('slot') ?? '').split('|')
  const leadId = String(form.get('leadId') ?? '').trim()
  const startsAt = new Date(iso ?? '')
  if (!leadId || !repKey || Number.isNaN(startsAt.getTime())) return
  const res = await holdSlot({ organizationId: user.organizationId, leadId, repKey, startsAt, heldBy: 'rep' })
  if (!res.ok) console.warn('[call-center-calendar] hold refused', { reason: res.reason })
  revalidatePath('/call-center')
}

export async function confirmCalendarSlot(form: FormData): Promise<void> {
  const user = await actor()
  await confirmSlot({ organizationId: user.organizationId, slotId: String(form.get('slotId') ?? ''), userId: user.id })
  revalidatePath('/call-center')
}

export async function saveCalendarOutcome(form: FormData): Promise<void> {
  const user = await actor()
  const outcome = String(form.get('outcome') ?? '')
  if (!isOutcome(outcome)) return
  await recordSlotOutcome({ organizationId: user.organizationId, slotId: String(form.get('slotId') ?? ''), outcome })
  revalidatePath('/call-center')
}
