'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { ForbiddenError, requireUser } from '@/lib/rbac'
import { CoachingError, createCoachingNote } from '@/lib/coaching'

export type CoachingNoteState = { error?: string; ok?: boolean }

const noteSchema = z.object({
  subjectId: z.string().min(1, 'Pick a closer.'),
  kind: z.enum(['ONE_ON_ONE', 'CALL_QA']),
  score: z.coerce.number().int().min(1).max(10).optional(),
  strengths: z.string().max(2000).optional(),
  improvements: z.string().max(2000).optional(),
  body: z.string().min(1, 'Write the note body.').max(8000),
  clientId: z.string().optional(),
})

export async function createCoachingNoteAction(
  _prev: CoachingNoteState,
  formData: FormData,
): Promise<CoachingNoteState> {
  const parsed = noteSchema.safeParse({
    subjectId: formData.get('subjectId'),
    kind: formData.get('kind'),
    score: formData.get('score') || undefined,
    strengths: formData.get('strengths') || undefined,
    improvements: formData.get('improvements') || undefined,
    body: formData.get('body'),
    clientId: formData.get('clientId') || undefined,
  })
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  try {
    const user = await requireUser()
    await createCoachingNote(user, {
      subjectId: parsed.data.subjectId,
      kind: parsed.data.kind,
      score: parsed.data.score ?? null,
      strengths: parsed.data.strengths ?? null,
      improvements: parsed.data.improvements ?? null,
      body: parsed.data.body,
      clientId: parsed.data.clientId ?? null,
    })
    revalidatePath('/sales/coaching')
    return { ok: true }
  } catch (error) {
    if (error instanceof CoachingError || error instanceof ForbiddenError) {
      return { error: error.message }
    }
    throw error
  }
}
