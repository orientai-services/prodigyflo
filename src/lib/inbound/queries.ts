import 'server-only'
import type { InboundCategory, IntakeSourceKind, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { clientScope, type SessionUser } from '@/lib/rbac'
import { defForIntakeKind } from '@/lib/connectors/catalog'

/**
 * Read model for the /inbound receiver. Every query is organization-scoped, and
 * every client name/link is resolved through `clientScope` so a viewer never
 * learns a client exists outside their reach. The receiver layers on top of the
 * intake pipeline non-destructively: it only reads InboundEvent / InboundDocument.
 *
 * NOTE: authored here so the /inbound UI slice compiles, runs, and tests in
 * isolation. If a parallel backend build also lands `@/lib/inbound/queries`,
 * reconcile — the exported signatures below are the contract both must honor.
 */

export const STREAM_PAGE_SIZE = 25

export type ConnectorMeta = {
  sourceId: string
  name: string
  defId: string | null
  glyph: string
  accent: string
}

export type StreamRow = {
  id: string
  category: InboundCategory
  eventType: string
  summary: string
  externalId: string
  occurredAt: Date
  createdAt: Date
  submissionId: string | null
  clientId: string | null
  /** Non-null only when the linked client is within the viewer's scope. */
  clientName: string | null
  /** True when an event carries a clientId the viewer is not allowed to see. */
  clientHidden: boolean
  connector: ConnectorMeta
}

export type StreamFilters = {
  category?: InboundCategory
  sourceId?: string
  search?: string
  /** ISO date (inclusive lower bound on occurredAt). */
  since?: string
  /** ISO date (inclusive upper bound on occurredAt). */
  until?: string
  page?: number
}

export type StreamPage = {
  rows: StreamRow[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export type InboundDocumentRow = {
  id: string
  name: string
  status: string
  note: string | null
  url: string | null
  externalId: string
  receivedAt: Date
  updatedAt: Date
  clientId: string | null
  clientName: string | null
  clientHidden: boolean
  connector: ConnectorMeta | null
}

export type DocumentFilters = {
  status?: string
  search?: string
}

export type InboundStats = {
  total: number
  today: number
  todayByCategory: { category: InboundCategory; count: number }[]
  unmatched: number
  connectors: (ConnectorMeta & { count: number })[]
}

export type EventDetail = {
  id: string
  category: InboundCategory
  eventType: string
  summary: string
  externalId: string
  occurredAt: Date
  createdAt: Date
  submissionId: string | null
  clientId: string | null
  clientName: string | null
  clientHidden: boolean
  connector: ConnectorMeta
  normalized: Prisma.JsonValue
  rawPayload: Prisma.JsonValue
}

function connectorMeta(
  sourceId: string,
  kind: IntakeSourceKind | undefined,
  defId: string | null,
  name: string | undefined,
): ConnectorMeta {
  const def = kind ? defForIntakeKind(kind, defId) : null
  return {
    sourceId,
    name: name ?? def?.name ?? 'Unknown source',
    defId: defId ?? def?.id ?? null,
    glyph: def?.glyph ?? '📥',
    accent: def?.accent ?? '#64748b',
  }
}

function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

/**
 * Resolve a set of client ids to {id -> "First Last"} within the viewer's
 * client scope. Ids that resolve are visible; ids that were requested but not
 * returned belong to clients out of scope (matched-but-hidden).
 */
async function resolveClientNames(
  user: SessionUser,
  clientIds: (string | null)[],
): Promise<Map<string, string>> {
  const ids = [...new Set(clientIds.filter((v): v is string => Boolean(v)))]
  if (ids.length === 0) return new Map()
  const clients = await db.client.findMany({
    where: { AND: [clientScope(user), { id: { in: ids } }] },
    select: { id: true, firstName: true, lastName: true },
  })
  return new Map(clients.map((c) => [c.id, `${c.firstName} ${c.lastName}`.trim()]))
}

/** Load the IntakeSources referenced by a batch of rows, keyed by id. */
async function loadSources(organizationId: string, sourceIds: (string | null)[]) {
  const ids = [...new Set(sourceIds.filter((v): v is string => Boolean(v)))]
  if (ids.length === 0) return new Map<string, { kind: IntakeSourceKind; connectorDefId: string | null; name: string }>()
  const sources = await db.intakeSource.findMany({
    where: { organizationId, id: { in: ids } },
    select: { id: true, kind: true, connectorDefId: true, name: true },
  })
  return new Map(sources.map((s) => [s.id, { kind: s.kind, connectorDefId: s.connectorDefId, name: s.name }]))
}

export async function getInboundStream(user: SessionUser, filters: StreamFilters = {}): Promise<StreamPage> {
  const page = Math.max(1, Math.floor(filters.page ?? 1))
  const pageSize = STREAM_PAGE_SIZE

  const occurredAt: Prisma.DateTimeFilter = {}
  if (filters.since) {
    const d = new Date(filters.since)
    if (!Number.isNaN(d.getTime())) occurredAt.gte = d
  }
  if (filters.until) {
    const d = new Date(filters.until)
    if (!Number.isNaN(d.getTime())) {
      d.setHours(23, 59, 59, 999)
      occurredAt.lte = d
    }
  }

  const search = filters.search?.trim()
  const where: Prisma.InboundEventWhereInput = {
    organizationId: user.organizationId,
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.sourceId ? { sourceId: filters.sourceId } : {}),
    ...(occurredAt.gte || occurredAt.lte ? { occurredAt } : {}),
    ...(search
      ? {
          OR: [
            { summary: { contains: search, mode: 'insensitive' } },
            { externalId: { contains: search, mode: 'insensitive' } },
            { eventType: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  }

  const [total, events] = await Promise.all([
    db.inboundEvent.count({ where }),
    db.inboundEvent.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        category: true,
        eventType: true,
        summary: true,
        externalId: true,
        occurredAt: true,
        createdAt: true,
        submissionId: true,
        clientId: true,
        sourceId: true,
        connectorDefId: true,
      },
    }),
  ])

  const [names, sources] = await Promise.all([
    resolveClientNames(
      user,
      events.map((e) => e.clientId),
    ),
    loadSources(
      user.organizationId,
      events.map((e) => e.sourceId),
    ),
  ])

  const rows: StreamRow[] = events.map((e) => {
    const src = sources.get(e.sourceId)
    const name = e.clientId ? (names.get(e.clientId) ?? null) : null
    return {
      id: e.id,
      category: e.category,
      eventType: e.eventType,
      summary: e.summary,
      externalId: e.externalId,
      occurredAt: e.occurredAt,
      createdAt: e.createdAt,
      submissionId: e.submissionId,
      clientId: e.clientId,
      clientName: name,
      clientHidden: Boolean(e.clientId) && name === null,
      connector: connectorMeta(e.sourceId, src?.kind, e.connectorDefId ?? src?.connectorDefId ?? null, src?.name),
    }
  })

  return { rows, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) }
}

export async function getInboundDocuments(
  user: SessionUser,
  filters: DocumentFilters = {},
): Promise<InboundDocumentRow[]> {
  const search = filters.search?.trim()
  const where: Prisma.InboundDocumentWhereInput = {
    organizationId: user.organizationId,
    ...(filters.status ? { status: { equals: filters.status, mode: 'insensitive' } } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { note: { contains: search, mode: 'insensitive' } },
            { externalId: { contains: search, mode: 'insensitive' } },
            { client: { firstName: { contains: search, mode: 'insensitive' } } },
            { client: { lastName: { contains: search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  }

  const docs = await db.inboundDocument.findMany({
    where,
    orderBy: [{ receivedAt: 'desc' }, { updatedAt: 'desc' }],
    take: 200,
    select: {
      id: true,
      name: true,
      status: true,
      note: true,
      url: true,
      externalId: true,
      receivedAt: true,
      updatedAt: true,
      clientId: true,
      sourceId: true,
    },
  })

  const [names, sources] = await Promise.all([
    resolveClientNames(
      user,
      docs.map((d) => d.clientId),
    ),
    loadSources(
      user.organizationId,
      docs.map((d) => d.sourceId),
    ),
  ])

  return docs.map((d) => {
    const name = d.clientId ? (names.get(d.clientId) ?? null) : null
    const src = d.sourceId ? sources.get(d.sourceId) : undefined
    return {
      id: d.id,
      name: d.name,
      status: d.status,
      note: d.note,
      url: d.url,
      externalId: d.externalId,
      receivedAt: d.receivedAt,
      updatedAt: d.updatedAt,
      clientId: d.clientId,
      clientName: name,
      clientHidden: Boolean(d.clientId) && name === null,
      connector: d.sourceId ? connectorMeta(d.sourceId, src?.kind, src?.connectorDefId ?? null, src?.name) : null,
    }
  })
}

export async function getInboundStats(user: SessionUser): Promise<InboundStats> {
  const organizationId = user.organizationId
  const since = startOfToday()

  const [total, unmatched, todayGroups, sourceGroups] = await Promise.all([
    db.inboundEvent.count({ where: { organizationId } }),
    db.inboundEvent.count({ where: { organizationId, clientId: null } }),
    db.inboundEvent.groupBy({
      by: ['category'],
      where: { organizationId, occurredAt: { gte: since } },
      _count: { _all: true },
    }),
    db.inboundEvent.groupBy({
      by: ['sourceId'],
      where: { organizationId },
      _count: { _all: true },
    }),
  ])

  const todayByCategory = todayGroups
    .map((g) => ({ category: g.category, count: g._count._all }))
    .sort((a, b) => b.count - a.count)
  const today = todayByCategory.reduce((sum, g) => sum + g.count, 0)

  const sources = await loadSources(
    organizationId,
    sourceGroups.map((g) => g.sourceId),
  )
  const connectors = sourceGroups
    .map((g) => {
      const src = sources.get(g.sourceId)
      return { ...connectorMeta(g.sourceId, src?.kind, src?.connectorDefId ?? null, src?.name), count: g._count._all }
    })
    .sort((a, b) => b.count - a.count)

  return { total, today, todayByCategory, unmatched, connectors }
}

export async function getInboundEvent(user: SessionUser, eventId: string): Promise<EventDetail | null> {
  const event = await db.inboundEvent.findFirst({
    where: { id: eventId, organizationId: user.organizationId },
    select: {
      id: true,
      category: true,
      eventType: true,
      summary: true,
      externalId: true,
      occurredAt: true,
      createdAt: true,
      submissionId: true,
      clientId: true,
      sourceId: true,
      connectorDefId: true,
      normalized: true,
      rawPayload: true,
    },
  })
  if (!event) return null

  const [names, sources] = await Promise.all([
    resolveClientNames(user, [event.clientId]),
    loadSources(user.organizationId, [event.sourceId]),
  ])
  const src = sources.get(event.sourceId)
  const name = event.clientId ? (names.get(event.clientId) ?? null) : null

  return {
    id: event.id,
    category: event.category,
    eventType: event.eventType,
    summary: event.summary,
    externalId: event.externalId,
    occurredAt: event.occurredAt,
    createdAt: event.createdAt,
    submissionId: event.submissionId,
    clientId: event.clientId,
    clientName: name,
    clientHidden: Boolean(event.clientId) && name === null,
    connector: connectorMeta(event.sourceId, src?.kind, event.connectorDefId ?? src?.connectorDefId ?? null, src?.name),
    normalized: event.normalized,
    rawPayload: event.rawPayload,
  }
}
