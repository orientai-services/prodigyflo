'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { createClientRecord } from '@/lib/clients'
import { findDuplicates } from '@/lib/dedupe'
import { ForbiddenError, requirePermission, userScope } from '@/lib/rbac'

const schema = z.object({
  firstName: z.string().trim().min(1, 'First name is required.').max(80),
  lastName: z.string().trim().min(1, 'Last name is required.').max(80),
  email: z.string().trim().email('Enter a valid email address.'),
  phone: z.string().trim().min(7, 'Enter a valid phone number.').max(25),
  preferredLanguage: z.string().trim().max(10).default('en'),
  preferredContact: z.enum(['phone', 'email', 'sms']).default('phone'),
  ownerId: z.string().trim().optional(),
  leadSourceId: z.string().trim().optional(),
  estimatedValue: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? Number(v.replace(/[$,]/g, '')) : null))
    .refine((v) => v === null || (Number.isFinite(v) && v >= 0), 'Enter a valid amount.'),
  line1: z.string().trim().max(120).optional(),
  line2: z.string().trim().max(120).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(40).optional(),
  postalCode: z.string().trim().max(12).optional(),
  note: z.string().trim().max(5000).optional(),
  /** Create even though duplicates were shown to the user. */
  force: z.boolean().default(false),
})

export type DuplicateSummary = {
  id: string
  name: string
  email: string
  matchedOn: string
}

export type CreateClientResult = {
  ok?: boolean
  clientId?: string
  error?: string
  fieldErrors?: Record<string, string>
  /** Present when duplicate detection stopped the insert. */
  duplicates?: { exact: DuplicateSummary[]; possible: DuplicateSummary[] }
}

export async function createClientAction(input: unknown): Promise<CreateClientResult> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0] ?? '_')] = issue.message
    return { error: 'Please fix the highlighted fields.', fieldErrors }
  }
  const data = parsed.data

  try {
    const user = await requirePermission('clients:create')

    if (data.line1 && (!data.city || !data.state || !data.postalCode)) {
      return {
        error: 'Please fix the highlighted fields.',
        fieldErrors: { city: 'City, state and postal code are required with an address.' },
      }
    }

    if (data.ownerId) {
      const owner = await db.user.findFirst({ where: { AND: [userScope(user), { id: data.ownerId }] } })
      if (!owner) return { error: 'That owner is not available to you.' }
    }

    // Duplicate detection happens BEFORE the insert, every time. `force`
    // only skips the stop, never the check.
    const { exact, possible } = await findDuplicates(db, user.organizationId, {
      email: data.email,
      phone: data.phone,
      firstName: data.firstName,
      lastName: data.lastName,
      postalCode: data.postalCode,
    })
    if (!data.force && (exact.length > 0 || possible.length > 0)) {
      const summarize = (matches: typeof exact): DuplicateSummary[] =>
        matches.map((m) => ({
          id: m.client.id,
          name: `${m.client.firstName} ${m.client.lastName}`,
          email: m.client.email,
          matchedOn: m.matchedOn,
        }))
      return { duplicates: { exact: summarize(exact), possible: summarize(possible) } }
    }

    const client = await createClientRecord(user, {
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email,
      phone: data.phone,
      preferredLanguage: data.preferredLanguage,
      preferredContact: data.preferredContact,
      ownerId: data.ownerId || null,
      leadSourceId: data.leadSourceId || null,
      estimatedValue: data.estimatedValue,
      address: data.line1
        ? {
            line1: data.line1,
            line2: data.line2 || null,
            city: data.city!,
            state: data.state!,
            postalCode: data.postalCode!,
          }
        : null,
      note: data.note || null,
    })

    revalidatePath('/clients')
    return { ok: true, clientId: client.id }
  } catch (error) {
    if (error instanceof ForbiddenError) return { error: error.message }
    throw error
  }
}
