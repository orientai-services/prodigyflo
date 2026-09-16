import { CASE_DOC_KINDS, matchDocKind } from '@/lib/daily-desk-docs'

export const QUEUE_BUCKETS = ['unassigned', 'unscheduled', 'missing_docs', 'cys'] as const
export type QueueBucketKey = (typeof QUEUE_BUCKETS)[number]

export type QueueReason = { bucket: QueueBucketKey; why: string }

export type QueueRowInput = {
  ownerId: string | null
  hasUpcomingAppointment: boolean
  missingDocLabels: string[]
  cysBlockers: string[]
}

export function queueReasons(input: QueueRowInput): QueueReason[] {
  const out: QueueReason[] = []
  if (!input.ownerId) out.push({ bucket: 'unassigned', why: 'No closer assigned' })
  if (!input.hasUpcomingAppointment) out.push({ bucket: 'unscheduled', why: 'No upcoming appointment' })
  if (input.missingDocLabels.length > 0) {
    out.push({
      bucket: 'missing_docs',
      why: `${input.missingDocLabels.length} missing · ${input.missingDocLabels.slice(0, 4).join(', ')}`,
    })
  }
  if (input.cysBlockers.length > 0) {
    out.push({
      bucket: 'cys',
      why: `${input.cysBlockers.length} CYS blocker${input.cysBlockers.length === 1 ? '' : 's'} · ${input.cysBlockers[0]}`,
    })
  }
  return out
}

export function missingPacketKinds(docs: { requirementKey: string | null; detectedTypeKey: string | null; label: string | null; hasFile: boolean }[]): string[] {
  const present = new Set<string>()
  for (const d of docs) {
    if (!d.hasFile) continue
    const kind = matchDocKind(d.requirementKey) || matchDocKind(d.detectedTypeKey) || matchDocKind(d.label)
    if (kind) present.add(kind.key)
  }
  return CASE_DOC_KINDS.filter((k) => !present.has(k.key)).map((k) => k.label)
}

export const QUEUE_BUCKET_META: Record<QueueBucketKey, { title: string; description: string }> = {
  unassigned: { title: 'Unassigned', description: 'Live files with no closer / ownerId.' },
  unscheduled: { title: 'Unscheduled', description: 'No upcoming SCHEDULED or CONFIRMED appointment.' },
  missing_docs: {
    title: 'Missing documents',
    description: 'Packet kinds with no file, including UCC / deed / permit / production.',
  },
  cys: { title: 'CYS blockers', description: 'Required fields missing, suggested, or in conflict. Not CYS approvedAt.' },
}
