import 'server-only'
import { db } from '@/lib/db'
import { humanize } from '@/lib/format'
import { canSeeInternal, type SessionUser } from '@/lib/rbac'

export type TimelineKind =
  | 'stage'
  | 'communication'
  | 'document'
  | 'document_review'
  | 'task'
  | 'task_completed'
  | 'note'
  | 'appointment'
  | 'submission'
  | 'intake'
  | 'audit'

export type TimelineEvent = {
  id: string
  kind: TimelineKind
  at: Date
  title: string
  description?: string
  actor?: string
  badge?: string
  isInternal?: boolean
}

export type TimelinePage = {
  events: TimelineEvent[]
  hasMore: boolean
}

/**
 * One merged, chronological feed for a client. Each source is queried
 * separately with the same take, so the merged prefix is always correct;
 * "load more" simply re-renders with a larger limit.
 */
export async function buildTimeline(
  user: SessionUser,
  clientId: string,
  { limit = 25 }: { limit?: number } = {},
): Promise<TimelinePage> {
  const take = limit + 1
  const internalOk = canSeeInternal(user)

  const [stages, comms, docs, reviews, tasks, notes, appointments, submissions, intakes, audits] =
    await Promise.all([
      db.stageHistory.findMany({
        where: { clientId },
        orderBy: { enteredAt: 'desc' },
        take,
        include: { stage: { select: { name: true } }, changedBy: { select: { name: true } } },
      }),
      db.communication.findMany({
        where: { clientId, ...(internalOk ? {} : { isInternal: false }) },
        orderBy: { occurredAt: 'desc' },
        take,
        include: { user: { select: { name: true } }, call: true },
      }),
      db.clientDocument.findMany({
        where: { clientId },
        orderBy: { createdAt: 'desc' },
        take,
        include: { requirement: { select: { name: true } } },
      }),
      db.documentReview.findMany({
        where: { document: { clientId } },
        orderBy: { reviewedAt: 'desc' },
        take,
        include: {
          reviewer: { select: { name: true } },
          document: {
            select: { fileName: true, label: true, requirement: { select: { name: true } } },
          },
        },
      }),
      db.task.findMany({
        where: { clientId },
        orderBy: { createdAt: 'desc' },
        take,
        include: { assignee: { select: { name: true } }, createdBy: { select: { name: true } } },
      }),
      db.note.findMany({
        where: { clientId, ...(internalOk ? {} : { isInternal: false }) },
        orderBy: { createdAt: 'desc' },
        take,
        include: { author: { select: { name: true } } },
      }),
      db.appointment.findMany({
        where: { clientId },
        orderBy: { createdAt: 'desc' },
        take,
        include: { owner: { select: { name: true } } },
      }),
      db.submission.findMany({ where: { clientId }, orderBy: { createdAt: 'desc' }, take }),
      db.intakeSubmission.findMany({
        where: { clientId },
        orderBy: { createdAt: 'desc' },
        take,
        include: { source: { select: { name: true } } },
      }),
      db.auditEvent.findMany({
        where: {
          organizationId: user.organizationId,
          entityType: 'Client',
          entityId: clientId,
          OR: [
            { action: { contains: 'correct' } },
            { action: { contains: 'approv' } },
            { action: { contains: 'review' } },
            { action: { contains: 'override' } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take,
      }),
    ])

  const events: TimelineEvent[] = []

  for (const s of stages) {
    const fromLabel = s.fromKey ? humanize(s.fromKey) : null
    events.push({
      id: `stage-${s.id}`,
      kind: 'stage',
      at: s.enteredAt,
      title: fromLabel ? `Stage: ${fromLabel} → ${s.stage.name}` : `Entered ${s.stage.name}`,
      description: [s.reason, s.note].filter(Boolean).join(' — ') || undefined,
      actor: s.automated ? 'Automation' : (s.changedBy?.name ?? undefined),
    })
  }

  for (const c of comms) {
    const channel = humanize(c.channel)
    const dir = c.direction === 'INBOUND' ? 'from client' : 'to client'
    events.push({
      id: `comm-${c.id}`,
      kind: 'communication',
      at: c.occurredAt,
      title: c.subject ? `${channel} ${dir}: ${c.subject}` : `${channel} ${dir}`,
      description: c.call
        ? `${humanize(c.call.outcome)} · ${Math.round(c.call.durationSeconds / 60)}m`
        : (c.body ?? undefined),
      actor: c.user?.name ?? undefined,
      badge: humanize(c.status),
      isInternal: c.isInternal,
    })
  }

  for (const d of docs) {
    const name = d.requirement?.name ?? d.label ?? d.fileName ?? 'Document'
    events.push({
      id: `doc-${d.id}`,
      kind: 'document',
      at: d.receivedAt ?? d.createdAt,
      title: d.receivedAt ? `Document received: ${name}` : `Document requested: ${name}`,
      badge: humanize(d.status),
    })
  }

  for (const r of reviews) {
    const name = r.document.requirement?.name ?? r.document.label ?? r.document.fileName ?? 'Document'
    events.push({
      id: `docrev-${r.id}`,
      kind: 'document_review',
      at: r.reviewedAt,
      title: `Document ${humanize(r.decision).toLowerCase()}: ${name}`,
      description: r.reason ?? undefined,
      actor: r.reviewer.name,
    })
  }

  for (const t of tasks) {
    events.push({
      id: `task-${t.id}`,
      kind: 'task',
      at: t.createdAt,
      title: `Task created: ${t.title}`,
      description: t.assignee ? `Assigned to ${t.assignee.name}` : undefined,
      actor: t.createdBy?.name ?? undefined,
      badge: humanize(t.priority),
    })
    if (t.completedAt) {
      events.push({
        id: `taskdone-${t.id}`,
        kind: 'task_completed',
        at: t.completedAt,
        title: `Task completed: ${t.title}`,
        actor: t.assignee?.name ?? undefined,
      })
    }
  }

  for (const n of notes) {
    events.push({
      id: `note-${n.id}`,
      kind: 'note',
      at: n.createdAt,
      title: n.isInternal ? 'Internal note' : 'Note (client-visible)',
      description: n.body,
      actor: n.author?.name ?? undefined,
      isInternal: n.isInternal,
    })
  }

  for (const a of appointments) {
    const when = a.startsAt.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
    events.push({
      id: `appt-${a.id}`,
      kind: 'appointment',
      at: a.createdAt,
      title: `${humanize(a.type)} appointment ${humanize(a.status).toLowerCase()}`,
      description: `Scheduled for ${when}${a.location ? ` · ${a.location}` : ''}`,
      actor: a.owner?.name ?? 'Unassigned',
    })
  }

  for (const s of submissions) {
    events.push({
      id: `sub-${s.id}`,
      kind: 'submission',
      at: s.submittedAt ?? s.createdAt,
      title: `Submission to ${s.destination} — ${humanize(s.status).toLowerCase()}`,
      description: s.externalRef ? `Ref ${s.externalRef}` : undefined,
      badge: `Attempt ${s.attemptNumber}`,
    })
  }

  for (const i of intakes) {
    events.push({
      id: `intake-${i.id}`,
      kind: 'intake',
      at: i.createdAt,
      title: `Intake submission via ${i.source.name}`,
      description: i.createdClient
        ? 'Created this client'
        : i.matchedOn
          ? `Matched on ${i.matchedOn}`
          : undefined,
      badge: humanize(i.status),
    })
  }

  for (const a of audits) {
    events.push({
      id: `audit-${a.id}`,
      kind: 'audit',
      at: a.createdAt,
      title: a.summary ?? humanize(a.action.replace(/[.:]/g, '_')),
      actor: a.actorLabel ?? undefined,
      badge: a.action,
    })
  }

  events.sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id))
  return { events: events.slice(0, limit), hasMore: events.length > limit }
}
