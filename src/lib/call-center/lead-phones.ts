import 'server-only'
import { db } from '@/lib/db'
import { readSecret } from './contact'
import { leadPhoneView, maySeeLeadPhone, type LeadPhoneView, type PhoneViewer } from './phone-display'

export type LeadPhoneViewer = PhoneViewer & { organizationId: string }

/**
 * Full numbers for the leads this viewer may see (phone-display.ts
 * `maySeeLeadPhone`), keyed by lead id. Leads the viewer may not see are left
 * out, so the caller falls back to the last four and nothing more reaches the
 * browser. No audit row: this is the same reach the dial already has, read on
 * every render, and an audit per render would bury the real events.
 */
export async function leadPhonesFor(viewer: LeadPhoneViewer, leadIds: readonly string[]): Promise<Map<string, LeadPhoneView>> {
  const out = new Map<string, LeadPhoneView>()
  const ids = [...new Set(leadIds.filter(Boolean))]
  if (!viewer.id || ids.length === 0) return out
  const superAdmin = viewer.role === 'SUPER_ADMIN'
  const rows = await db.callCenterLead.findMany({
    where: {
      organizationId: viewer.organizationId,
      id: { in: ids },
      // A rep only ever reads the leads they hold, so nobody else's secret is decrypted.
      ...(superAdmin ? {} : { lockedBy: viewer.id, doNotCallAt: null }),
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
    return phone ? { ...r, phone } : r
  })
}
