import { z } from 'zod'

export const SUNOFF_PARTNERS = {
  '63': { email: 'itsgatsby@protonmail.com', key: 'gatsby', name: 'Gatsby' },
  '169': { email: 'dakota.hanshew@gmail.com', key: 'dakota', name: 'Dakota' },
} as const
const stamp = z.number().int().nonnegative().max(8_640_000_000_000_000)
export const assignmentSnapshot = z.object({
  version: z.literal(1), revision: stamp.positive(), complete: z.literal(true),
  leads: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), brand: z.literal('sunoff'),
    userId: z.enum(['63', '169']), name: z.string().min(1).max(160),
    phone: z.string().max(50), email: z.string().max(200).nullable(), address: z.string().max(600).nullable(),
    language: z.enum(['EN', 'ES']), createdAt: stamp, updatedAt: stamp,
    appointmentAt: stamp.nullable(), followupAt: stamp.nullable(),
    stage: z.string().max(80), closed: z.boolean(), doNotCall: z.boolean(),
    consent: z.object({ at: stamp, source: z.enum(['meta', 'manual', 'csv']), formId: z.string().max(100).nullable(),
      version: z.string().max(100).nullable(), revokedAt: stamp.nullable(), expiresAt: stamp.nullable() }).nullable(),
  })).max(1000),
}).superRefine((s, ctx) => {
  if (new Set(s.leads.map(l => l.id)).size !== s.leads.length) ctx.addIssue({ code: 'custom', message: 'Duplicate source ids' })
  if (s.leads.some(l => l.updatedAt > s.revision)) ctx.addIssue({ code: 'custom', message: 'Snapshot predates its rows' })
})
export type AssignedLead = z.infer<typeof assignmentSnapshot>['leads'][number]
export function sourceMeta(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const m = (value as Record<string, unknown>).sunoff
  return m && typeof m === 'object' && !Array.isArray(m) ? m as Record<string, unknown> : null
}
export function mayManageSunoff(role: string | undefined, value: unknown): boolean {
  const m = sourceMeta(value)
  return role === 'SUPER_ADMIN' && m?.active === true && ['63', '169'].includes(String(m.userId))
}
export function sunoffActive(value: unknown): boolean { return sourceMeta(value)?.active !== false }
export function sunoffLeadId(org: string, id: string): string {
  return /^meta_\d+$/.test(id) ? `meta:${org}:${id.slice(5)}` : `sunoff:${org}:${id}`
}
export function sourceState(l: AssignedLead): string {
  return JSON.stringify([l.stage, l.closed, l.appointmentAt, l.followupAt, l.doNotCall])
}
export function sourceLabel(pageId: string | null | undefined): 'SunOff' | null { return pageId === 'sunoff' ? 'SunOff' : null }
