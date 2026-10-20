import 'server-only'
import { db } from '@/lib/db'
import { readSecret } from './contact'
import { leadPhoneView, maySeeLeadPhone, type LeadPhoneView, type PhoneViewer } from './phone-display'

export type LeadPhoneViewer = PhoneViewer & { organizationId: string }

/** Hydrate full phones for requested, already-visible records in the viewer's organization.
 * The caller supplies only ids returned by its authorized record query. Calling/texting gates
 * remain separate. Decryption failures are represented as unavailable instead of invented digits.
 */
export async function leadPhonesFor(viewer: LeadPhoneViewer, leadIds: readonly string[]): Promise<Map<string, LeadPhoneView>> {
  const out = new Map<string, LeadPhoneView>()
  const ids = [...new Set(leadIds.filter(Boolean))]
  if (!viewer.id || ids.length === 0) return out
  const rows = await db.callCenterLead.findMany({
    where: {
      organizationId: viewer.organizationId,
      id: { in: ids },
    },
    select: { id: true, lockedBy: true, doNotCallAt: true, phoneSecret: true, phoneLast4: true },
  })
  for (const row of rows) {
    if (!maySeeLeadPhone(viewer, row)) continue
    const view = leadPhoneView(readSecret(row.phoneSecret), Boolean(row.phoneSecret) || Boolean(row.phoneLast4))
    if (view) out.set(row.id, view)
  }
  return out
}

/** Puts `phone` on each row whose lead the viewer may see. */
export async function withLeadPhones<T extends { phone?: LeadPhoneView | null }>(
  viewer: LeadPhoneViewer,
  rows: T[],
  leadIdOf: (row: T) => string | null | undefined,
): Promise<T[]> {
  const phones = await leadPhonesFor(viewer, rows.map((r) => leadIdOf(r) ?? '').filter(Boolean))
  if (phones.size === 0) return rows
  return rows.map((r) => {
    const id = leadIdOf(r)
    const phone = id ? phones.get(id) : undefined
    return phone && r.phone?.state !== 'shown' ? { ...r, phone } : r
  })
}
