'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { ForbiddenError, findClientInScope, requirePermission } from '@/lib/rbac'
import { recordAudit } from '@/lib/audit'

/**
 * Records the signed solar agreement on a client — the Contract row the
 * attorney readiness gate (`src/lib/attorney.ts`) checks for. Until now the
 * gate could only be satisfied by seed data; this is the human write path.
 *
 * Gated by the existing `clients:update` permission (recording a contract is
 * editing the client record) and, like every server action, self-gates before
 * touching anything.
 */

const markSignedSchema = z.object({
  clientId: z.string().min(1),
  counterparty: z
    .string()
    .trim()
    .min(1, 'The contract counterparty (solar company) is required.')
    .max(200, 'Counterparty is too long.'),
  signedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A signed date is required.'),
  productType: z.enum(['lease', 'PPA', 'loan']).nullish(),
  notes: z.string().trim().max(1000, 'Notes are too long.').optional(),
})

export type MarkContractSignedResult =
  | { ok: true; contractId: string }
  | { ok: false; error: string }

export async function markContractSignedAction(raw: unknown): Promise<MarkContractSignedResult> {
  const parsed = markSignedSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' }
  }

  try {
    const user = await requirePermission('clients:update')
    const client = await findClientInScope(user, parsed.data.clientId)
    if (!client) return { ok: false, error: 'This client is not in your scope.' }

    // Date-only input; noon keeps the calendar day stable across timezones.
    const signedAt = new Date(`${parsed.data.signedOn}T12:00:00`)
    if (Number.isNaN(signedAt.getTime())) return { ok: false, error: 'Invalid signed date.' }
    if (signedAt.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
      return { ok: false, error: 'The signed date cannot be in the future.' }
    }

    const existing = await db.contract.findFirst({
      where: { clientId: client.id, signedAt: { not: null } },
      select: { counterparty: true },
    })
    if (existing) {
      return { ok: false, error: `A signed contract with ${existing.counterparty} is already on file.` }
    }

    const contract = await db.contract.create({
      data: {
        clientId: client.id,
        counterparty: parsed.data.counterparty,
        productType: parsed.data.productType ?? null,
        signedAt,
        notes: parsed.data.notes?.trim() || null,
        extractionSource: 'manual',
      },
    })

    await recordAudit(user, {
      action: 'contract.mark_signed',
      entityType: 'Contract',
      entityId: contract.id,
      summary: `Recorded signed contract with ${contract.counterparty} for ${client.firstName} ${client.lastName}`,
      after: {
        counterparty: contract.counterparty,
        productType: contract.productType,
        signedAt: contract.signedAt,
        source: 'manual',
      },
    })

    revalidatePath(`/clients/${client.id}`)
    // The attorney queue's readiness math turns on this row.
    revalidatePath('/attorney')
    revalidatePath(`/attorney/${client.id}`)

    return { ok: true, contractId: contract.id }
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: err.message }
    throw err
  }
}
