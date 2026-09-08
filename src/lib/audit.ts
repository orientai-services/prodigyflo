import 'server-only'
import { headers } from 'next/headers'
import { db } from '@/lib/db'
import { hashValue } from '@/lib/crypto'
import type { SessionUser } from '@/lib/rbac'

type AuditInput = {
  action: string
  entityType: string
  entityId?: string | null
  summary?: string
  before?: unknown
  after?: unknown
}

/**
 * Append an immutable audit event. Audit rows are never updated or deleted by
 * application code — only inserted.
 */
export async function recordAudit(actor: SessionUser, input: AuditInput): Promise<void> {
  let ipHash: string | null = null
  let userAgent: string | null = null
  try {
    const h = await headers()
    const forwarded = h.get('x-forwarded-for')?.split(',')[0]?.trim()
    if (forwarded) ipHash = hashValue(forwarded)
    userAgent = h.get('user-agent')?.slice(0, 400) ?? null
  } catch {
    // Outside a request context (seeds, jobs) — the actor is still recorded.
  }

  await db.auditEvent.create({
    data: {
      organizationId: actor.organizationId,
      actorId: actor.id,
      actorLabel: `${actor.name} (${actor.roleName})`,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      summary: input.summary ?? null,
      before: (input.before ?? undefined) as never,
      after: (input.after ?? undefined) as never,
      ipHash,
      userAgent,
    },
  })
}

/** Strip sensitive keys before they reach an audit payload. */
export function redactForAudit<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  const REDACTED = new Set([
    'passwordHash', 'password', 'ssn', 'socialSecurityNumber', 'dateOfBirth',
    'accountNumber', 'routingNumber', 'cardNumber', 'cvv', 'providerToken',
  ])
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, REDACTED.has(k) ? '[redacted]' : v]),
  )
}
