import 'server-only'
import type { Connector, IntakeSource, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ForbiddenError, requirePermission, type SessionUser } from '@/lib/rbac'
import { recordAudit } from '@/lib/audit'
import { getConnectorCredentials } from '@/lib/connectors/credentials'
import { connectInbound } from '@/lib/connectors/provision'
import { processInbound, type IntakeActor } from '@/lib/intake/apply'
import { recordInboundEvent } from '@/lib/inbound/record'
import {
  createGhlClient,
  initialGhlImportState,
  mergeGhlImportState,
  normalizeContact,
  normalizeOpportunity,
  parseGhlImportState,
  type GhlClient,
  type GhlFetch,
  type GhlImportPhase,
  type GhlImportState,
  type GhlPhaseCounts,
} from '@/lib/connectors/ghl'

/**
 * The GoHighLevel PULL importer — one bounded batch per call.
 *
 * Contacts ride the exact same rails as the gohighlevel webhook: each one goes
 * through `processInbound(source, contact.id, normalized)`, so idempotency
 * (sourceId, externalId), field mapping, dedupe-or-create and the audit trail
 * all come for free, and a webhook delivery for a contact this importer already
 * pulled is a recorded duplicate — never a second client. Opportunities are
 * filed as OPPORTUNITY InboundEvents via `recordInboundEvent`, linked to the
 * client their contact resolved to.
 *
 * RESUMABLE: cursor/phase/counts persist in the GO_HIGH_LEVEL Connector's
 * `config.ghlImport` after every page, and each invocation stops at a page/time
 * budget (GHL allows ~100 req/10s per location; we fetch a handful of pages
 * with an inter-page breather). The UI re-invokes until `done`.
 *
 * Credential material stays inside this process: ConnectorLog rows and audits
 * carry phase + counts only — never the token, never a URL that embeds it.
 */

export type GhlImportRunResult =
  | {
      ok: true
      phase: GhlImportPhase
      done: boolean
      contacts: GhlPhaseCounts
      opportunities: GhlPhaseCounts
      message: string
    }
  | { ok: false; error: string }

export type GhlImportBatchOptions = {
  /** Injectable for tests — never logged. */
  fetchImpl?: GhlFetch
  /** Injectable inter-page delay (defaults to a real ~150ms sleep). */
  sleep?: (ms: number) => Promise<void>
  /** Max pages fetched per invocation. */
  pageBudget?: number
  /** Wall-clock budget per invocation, ms. */
  timeBudgetMs?: number
  now?: () => Date
}

const PAGE_BUDGET = 8
const TIME_BUDGET_MS = 20_000
const INTER_PAGE_DELAY_MS = 150
const GHL_INBOUND_DEF_ID = 'gohighlevel'

const FORBIDDEN = { ok: false as const, error: 'You do not have permission to manage connectors.' }

async function manage(): Promise<SessionUser | null> {
  try {
    return await requirePermission('connectors:manage')
  } catch (e) {
    if (e instanceof ForbiddenError) return null
    throw e
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function describe(state: GhlImportState): string {
  const c = state.contacts
  const o = state.opportunities
  const contactsPart = `contacts: ${c.imported} imported, ${c.duplicates} duplicate${c.duplicates === 1 ? '' : 's'}, ${c.failed} failed`
  const oppsPart = `opportunities: ${o.imported} recorded, ${o.duplicates} duplicate${o.duplicates === 1 ? '' : 's'}, ${o.failed} skipped`
  if (state.phase === 'contacts') return `Importing ${contactsPart}…`
  if (state.phase === 'opportunities') return `Contacts done (${contactsPart}); importing ${oppsPart}…`
  return `Import complete — ${contactsPart}; ${oppsPart}.`
}

/** Counts-only snapshot for ConnectorLog / audit payloads. */
function countsDetail(state: GhlImportState): Prisma.InputJsonValue {
  return {
    phase: state.phase,
    contacts: { ...state.contacts },
    opportunities: { ...state.opportunities },
  }
}

async function persistState(connector: Pick<Connector, 'id'>, state: GhlImportState, now: Date): Promise<void> {
  // Re-read config at write time so we never clobber keys another feature
  // added to the same Connector row mid-import.
  const row = await db.connector.findUnique({ where: { id: connector.id }, select: { config: true } })
  await db.connector.update({
    where: { id: connector.id },
    data: {
      config: mergeGhlImportState(row?.config, state) as Prisma.InputJsonValue,
      lastSyncAt: now,
      lastSyncStatus: describe(state).slice(0, 500),
      // A persisted page is progress — clear any stale error. The catch path
      // re-sets lastError AFTER calling this, so real failures still surface.
      lastError: null,
    },
  })
}

/** The org's gohighlevel IntakeSource (enabled preferred), provisioned when absent. */
async function findOrProvisionSource(actor: SessionUser): Promise<IntakeSource | { error: string }> {
  const source = await db.intakeSource.findFirst({
    where: {
      organizationId: actor.organizationId,
      OR: [{ connectorDefId: GHL_INBOUND_DEF_ID }, { connectorDefId: null, kind: 'GO_HIGH_LEVEL' }],
    },
    orderBy: [{ isEnabled: 'desc' }, { createdAt: 'asc' }],
  })
  if (source) return source

  const created = await connectInbound(actor, { defId: GHL_INBOUND_DEF_ID })
  if (!created.ok) return { error: `Could not provision the GoHighLevel intake source: ${created.error}` }
  return db.intakeSource.findUniqueOrThrow({ where: { id: created.sourceId } })
}

async function importContactsPage(
  ghl: GhlClient,
  locationId: string,
  source: IntakeSource,
  state: GhlImportState,
  actor: IntakeActor,
): Promise<void> {
  const page = await ghl.listContacts(locationId, state.contactCursor)
  for (const contact of page.contacts) {
    try {
      const normalized = normalizeContact(contact)
      const { duplicate, submission } = await processInbound(source, contact.id, normalized, actor)
      if (duplicate || submission.status === 'DUPLICATE') state.contacts.duplicates += 1
      else if (submission.status === 'APPLIED') state.contacts.imported += 1
      // NEEDS_MAPPING / FAILED stay visible as submission rows — honest count.
      else state.contacts.failed += 1
    } catch {
      state.contacts.failed += 1
    }
  }
  state.contactCursor = page.nextCursor
  if (!page.nextCursor) state.phase = 'opportunities'
}

async function importOpportunitiesPage(
  ghl: GhlClient,
  locationId: string,
  source: IntakeSource,
  state: GhlImportState,
  now: Date,
): Promise<void> {
  const page = await ghl.searchOpportunities(locationId, state.opportunityPage)
  for (const opp of page.opportunities) {
    try {
      const externalId = `opp:${opp.id}`
      // recordInboundEvent has no idempotency key of its own — enforce one here
      // so a re-run reports duplicates instead of piling up event rows.
      const existing = await db.inboundEvent.findFirst({
        where: { sourceId: source.id, externalId },
        select: { id: true },
      })
      if (existing) {
        state.opportunities.duplicates += 1
        continue
      }
      // Link through the contact's submission (contacts phase ran first, so it
      // exists for any contact the location still has). Without one there is no
      // submission to anchor the event to — count it, don't invent rows.
      const contactSub = opp.contactId
        ? await db.intakeSubmission.findUnique({
            where: { sourceId_externalId: { sourceId: source.id, externalId: opp.contactId } },
            select: { id: true, clientId: true },
          })
        : null
      if (!contactSub) {
        state.opportunities.failed += 1
        continue
      }
      const recorded = await recordInboundEvent({
        source,
        submission: contactSub,
        payload: normalizeOpportunity(opp),
        externalId,
      })
      if (recorded.ok) state.opportunities.imported += 1
      else state.opportunities.failed += 1
    } catch {
      state.opportunities.failed += 1
    }
  }
  if (page.nextPage) {
    state.opportunityPage = page.nextPage
  } else {
    state.phase = 'done'
    state.finishedAt = now.toISOString()
  }
}

/**
 * Run one bounded import batch for the caller's ACTIVE organization. Returns
 * progress the UI renders live; call again until `done` is true. Safe to
 * re-invoke after completion — that starts a fresh (idempotent) pass whose
 * already-imported records report as duplicates.
 */
export async function runGhlImportBatch(
  user: SessionUser,
  opts: GhlImportBatchOptions = {},
): Promise<GhlImportRunResult> {
  const actor = await manage()
  if (!actor) return FORBIDDEN

  const now = opts.now ?? (() => new Date())
  const sleep = opts.sleep ?? defaultSleep
  const pageBudget = opts.pageBudget ?? PAGE_BUDGET
  const timeBudgetMs = opts.timeBudgetMs ?? TIME_BUDGET_MS

  // Credentials — decrypted here, used for API calls, and never persisted,
  // logged, audited or returned.
  const creds = await getConnectorCredentials(actor.organizationId, 'GO_HIGH_LEVEL')
  if (!creds?.apiToken || !creds?.locationId) {
    return {
      ok: false,
      error:
        'GoHighLevel is not connected yet — open the Credentials card, confirm your password, and store the Private Integration token and Location ID first.',
    }
  }

  const connector = await db.connector.findUnique({
    where: { organizationId_kind: { organizationId: actor.organizationId, kind: 'GO_HIGH_LEVEL' } },
    select: { id: true, config: true },
  })
  if (!connector) {
    // Unreachable in practice: getConnectorCredentials just read this row.
    return { ok: false, error: 'The GoHighLevel API connector is not set up for this organization.' }
  }

  const source = await findOrProvisionSource(actor)
  if ('error' in source) return { ok: false, error: source.error }

  // Resume where the last batch stopped; a finished (or absent) state starts fresh.
  const stored = parseGhlImportState(connector.config)
  const state: GhlImportState = stored && stored.phase !== 'done' ? stored : initialGhlImportState(now())
  const fresh = !stored || stored.phase === 'done'
  if (fresh) {
    await db.connectorLog.create({
      data: { connectorId: connector.id, event: 'ghl_import.started', detail: countsDetail(state) },
    })
  }

  const ghl = createGhlClient({ apiToken: creds.apiToken, fetchImpl: opts.fetchImpl })
  const intakeActor: IntakeActor = { id: actor.id, name: actor.name, roleName: actor.roleName }
  const startedTick = Date.now()
  let pages = 0

  try {
    while (state.phase !== 'done' && pages < pageBudget && Date.now() - startedTick < timeBudgetMs) {
      if (pages > 0) await sleep(INTER_PAGE_DELAY_MS)
      if (state.phase === 'contacts') {
        await importContactsPage(ghl, creds.locationId, source, state, intakeActor)
      } else {
        await importOpportunitiesPage(ghl, creds.locationId, source, state, now())
      }
      pages += 1
      await persistState(connector, state, now())
    }
  } catch (e) {
    // Progress up to the failed page is already persisted — the run resumes.
    const message = e instanceof Error ? e.message.slice(0, 500) : 'Unknown GoHighLevel import error.'
    await persistState(connector, state, now())
    await db.connector.update({
      where: { id: connector.id },
      data: { lastError: message, lastErrorAt: now() },
    })
    await db.connectorLog.create({
      data: {
        connectorId: connector.id,
        level: 'error',
        event: 'ghl_import.error',
        detail: { message, ...(countsDetail(state) as object) },
      },
    })
    return { ok: false, error: message }
  }

  const done = state.phase === 'done'
  await db.connectorLog.create({
    data: {
      connectorId: connector.id,
      event: done ? 'ghl_import.completed' : 'ghl_import.progress',
      detail: countsDetail(state),
    },
  })
  if (done) {
    await recordAudit(actor, {
      action: 'connector.ghl_import_completed',
      entityType: 'Connector',
      entityId: connector.id,
      summary: `GoHighLevel import finished — ${describe(state)}`,
      after: countsDetail(state) as Record<string, unknown>,
    })
  }

  return {
    ok: true,
    phase: state.phase,
    done,
    contacts: { ...state.contacts },
    opportunities: { ...state.opportunities },
    message: describe(state),
  }
}
