import 'server-only'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/rbac'
import { callLeadsForDesk, type StoredCallCenterLead } from './from-rows'

function missingCallCenterTable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = 'code' in err ? String((err as { code?: unknown }).code ?? '') : ''
  if (code === 'P2021' || code === '42P01') return true
  const message = err instanceof Error ? err.message : ''
  return /CallCenterLead/i.test(message) && /does not exist|undefined_table|P2021/i.test(message)
}

/** Desk rows for the signed-in workspace. Empty or unmigrated tables keep the seed. */
export async function loadCallCenterLeads() {
  const user = await getSessionUser()
  if (!user) return callLeadsForDesk([])
  try {
    const rows = await db.callCenterLead.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: 'desc' },
      include: { events: { orderBy: { createdAt: 'asc' } } },
    })
    const stored: StoredCallCenterLead[] = rows.map((row) => ({
      id: row.id,
      pageId: row.pageId,
      source: row.source,
      language: row.language,
      status: row.status,
      tries: row.tries,
      nextAttemptAt: row.nextAttemptAt,
      lockedBy: row.lockedBy,
      doNotCallAt: row.doNotCallAt,
      phoneLast4: row.phoneLast4,
      createdAt: row.createdAt,
      events: row.events.map((event) => ({
        type: event.type,
        body: event.body,
        createdAt: event.createdAt,
      })),
    }))
    return callLeadsForDesk(stored)
  } catch (err) {
    if (missingCallCenterTable(err)) return callLeadsForDesk([])
    throw err
  }
}
