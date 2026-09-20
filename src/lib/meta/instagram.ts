import 'server-only'
import { IntakeSourceKind } from '@prisma/client'
import { db } from '@/lib/db'
import { hashValue } from '@/lib/crypto'
import { metaCredentialsFor } from './provider'
import { firstTouch } from './ignition'

/**
 * Instagram engagement → CRM leads.
 *
 * Instagram DMs, comments, and story replies arrive on the same Meta app + app
 * secret as Lead Ads, but carry a name + @handle + message rather than an
 * email/phone — so they can't go through the standard intake pipeline (which
 * requires a contact method). This module ingests them in isolation: it keys a
 * Client on the STABLE Instagram-scoped sender id (dedupe), backfills the display
 * @handle, dedupes repeat messagers to one client, and drops a ready-to-send
 * bilingual reply on the record. It never touches the Lead Ads / intake path.
 */

const GRAPH = 'https://graph.facebook.com/v21.0'

// Bound how much one webhook delivery can create — a signed sender should never
// be able to fan a single POST into unbounded DB work.
const MAX_ENTRIES = 100
const MAX_PER_ARRAY = 100
const MAX_EVENTS = 200

export type InstagramEvent = {
  kind: 'dm' | 'comment' | 'story'
  igsid: string // Instagram-scoped id of the sender — the stable dedupe key
  username?: string // @handle, when the payload already carries it (comments do)
  text: string
  eventId: string // message id / comment id — the idempotency key
}

type IgMessaging = {
  sender?: { id?: string }
  recipient?: { id?: string }
  message?: { mid?: string; text?: string; is_echo?: boolean; reply_to?: { story?: unknown } }
}
type IgChange = {
  field?: string
  value?: { id?: string; text?: string; from?: { id?: string; username?: string } }
}
type IgEntry = { id?: string; messaging?: IgMessaging[]; changes?: IgChange[] }
export type InstagramWebhookBody = { object?: string; entry?: IgEntry[] }

function isP2002(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'P2002')
}

/** Normalize an Instagram webhook body into discrete lead events (bounded). */
export function parseInstagramEvents(body: InstagramWebhookBody): InstagramEvent[] {
  const out: InstagramEvent[] = []
  for (const entry of (body.entry ?? []).slice(0, MAX_ENTRIES)) {
    if (out.length >= MAX_EVENTS) break
    const businessId = entry.id
    // Direct messages (story replies arrive here too, tagged reply_to.story).
    for (const m of (entry.messaging ?? []).slice(0, MAX_PER_ARRAY)) {
      if (out.length >= MAX_EVENTS) break
      if (m.message?.is_echo) continue // our own outgoing message echoed back
      const igsid = m.sender?.id
      const text = m.message?.text?.trim()
      if (!igsid || igsid === businessId || !text || !m.message?.mid) continue
      out.push({ kind: m.message?.reply_to?.story ? 'story' : 'dm', igsid, text, eventId: m.message.mid })
    }
    // Comments on posts/ads. (Story mentions arrive with a different value shape
    // that carries no sender identity, so they can't become a lead — not handled.)
    for (const c of (entry.changes ?? []).slice(0, MAX_PER_ARRAY)) {
      if (out.length >= MAX_EVENTS) break
      if (c.field !== 'comments') continue
      const v = c.value ?? {}
      const igsid = v.from?.id
      const text = v.text?.trim()
      // Skip the business account's own comments/replies (from.id === page ig id).
      if (!igsid || igsid === businessId || !text || !v.id) continue
      out.push({ kind: 'comment', igsid, username: v.from?.username, text, eventId: v.id })
    }
  }
  return out
}

/** Best-effort: resolve @username + display name from an Instagram-scoped id. */
export async function fetchInstagramUser(igsid: string, token: string): Promise<{ username?: string; name?: string }> {
  if (!token) return {}
  try {
    const qs = new URLSearchParams({ fields: 'name,username', access_token: token })
    const res = await fetch(`${GRAPH}/${encodeURIComponent(igsid)}?${qs}`)
    const body = (await res.json().catch(() => ({}))) as { name?: string; username?: string; error?: unknown }
    if (!res.ok || body.error) return {}
    return { username: body.username, name: body.name }
  } catch {
    return {}
  }
}

/** The intake source Instagram leads are tracked under — created on first use. */
export async function ensureInstagramIntakeSource(organizationId: string) {
  const find = () =>
    db.intakeSource.findFirst({ where: { organizationId, kind: IntakeSourceKind.GENERIC_WEBHOOK, slug: 'instagram' } })
  const existing = await find()
  if (existing) return existing
  const leadSource = await db.leadSource.upsert({
    where: { organizationId_key: { organizationId, key: 'instagram' } },
    create: { organizationId, key: 'instagram', name: 'Instagram', channel: 'organic_social' },
    update: {},
  })
  try {
    return await db.intakeSource.create({
      data: {
        organizationId,
        kind: IntakeSourceKind.GENERIC_WEBHOOK,
        connectorDefId: 'instagram',
        name: 'Instagram',
        slug: 'instagram',
        // Webhook auth is Meta's own X-Hub-Signature-256; no per-source secret.
        secretHash: hashValue(`ig:${organizationId}`),
        defaultLeadSourceId: leadSource.id,
      },
    })
  } catch (err) {
    // A concurrent first delivery won the @@unique([organizationId, slug]) race.
    if (isP2002(err)) {
      const winner = await find()
      if (winner) return winner
    }
    throw err
  }
}

export type IgIngestResult = { duplicate: boolean; created: boolean; clientId: string | null }

const CHANNEL_LABEL: Record<InstagramEvent['kind'], string> = {
  dm: 'Instagram DM',
  comment: 'Instagram comment',
  story: 'Instagram story reply',
}

/**
 * Ingest one Instagram event into the CRM. Idempotent on (source, eventId);
 * repeat messagers (same IGSID) append to their existing client rather than
 * creating duplicates. A failure after the idempotency marker deletes the marker
 * so Meta's redelivery legitimately re-creates the lead (never a silent drop).
 */
export async function ingestInstagramEvent(organizationId: string, ev: InstagramEvent): Promise<IgIngestResult> {
  const source = await ensureInstagramIntakeSource(organizationId)
  const externalId = `ig:${ev.kind}:${ev.eventId}`

  // Idempotency guard — one submission per event. A redelivery short-circuits
  // here (before any lead work or Graph call).
  try {
    await db.intakeSubmission.create({
      data: { organizationId, sourceId: source.id, externalId, status: 'RECEIVED', rawPayload: ev as unknown as object },
    })
  } catch (err) {
    if (isP2002(err)) return { duplicate: true, created: false, clientId: null }
    throw err
  }

  const markSubmission = (data: Record<string, unknown>) =>
    db.intakeSubmission.updateMany({ where: { sourceId: source.id, externalId }, data: { ...data, processedAt: new Date() } })

  try {
    const channel = CHANNEL_LABEL[ev.kind]

    // Dedupe on the STABLE IGSID — no profile lookup needed, and a flaky handle
    // resolution can never split a repeat messager into two clients.
    const prior = await db.client.findFirst({
      where: { organizationId, instagramUserId: ev.igsid, deletedAt: null },
      select: { id: true, instagramHandle: true },
    })
    if (prior) {
      const label = prior.instagramHandle ?? `ig:${ev.igsid}`
      await db.note.create({ data: { clientId: prior.id, authorId: null, body: `📩 ${channel} from ${label}:\n${ev.text}`, isInternal: true } })
      await db.client.update({ where: { id: prior.id }, data: { lastActivityAt: new Date() } })
      await markSubmission({ status: 'DUPLICATE', clientId: prior.id })
      return { duplicate: false, created: false, clientId: prior.id }
    }

    // New sender — resolve the @username + name ONCE. Comments carry it; DMs need
    // a Graph lookup (best-effort; falls back to the raw id).
    let username = ev.username
    let name: string | undefined
    if (!username) {
      const creds = await metaCredentialsFor(organizationId)
      const prof = await fetchInstagramUser(ev.igsid, creds.pageAccessToken ?? creds.systemUserToken ?? '')
      username = prof.username
      name = prof.name
    }
    const handle = username ? `@${username.replace(/^@/, '')}` : null
    const label = handle ?? `ig:${ev.igsid}`
    const [firstName, ...rest] = (name ?? username ?? 'Instagram').trim().split(/\s+/)
    const lastName = rest.join(' ') || '(Instagram)'
    const messageNote = `📩 ${channel} from ${label}:\n${ev.text}`

    const pipeline =
      (await db.pipeline.findFirst({ where: { organizationId, isDefault: true }, include: { stages: { orderBy: { position: 'asc' }, take: 1 } } })) ??
      (await db.pipeline.findFirst({ where: { organizationId }, include: { stages: { orderBy: { position: 'asc' }, take: 1 } } }))
    const firstStage = pipeline?.stages[0]
    if (!pipeline || !firstStage) {
      await markSubmission({ status: 'FAILED', error: 'No pipeline with stages exists for this organization.' })
      return { duplicate: false, created: false, clientId: null }
    }

    const defaultCloser = source.defaultOwnerId
      ? await db.user.findFirst({ where: { id: source.defaultOwnerId, organizationId, isActive: true, deletedAt: null, role: { key: 'CLOSER' } }, select: { id: true } })
      : null
    let client
    try {
      client = await db.client.create({
        data: {
          organizationId,
          pipelineId: pipeline.id,
          currentStageId: firstStage.id,
          firstName: firstName || 'Instagram',
          lastName,
          email: '',
          phone: '',
          instagramUserId: ev.igsid,
          instagramHandle: handle,
          preferredContact: 'instagram',
          leadSourceId: source.defaultLeadSourceId,
          ownerId: defaultCloser?.id ?? null,
          utmSource: 'instagram',
          utmMedium: ev.kind,
          stageEnteredAt: new Date(),
          lastActivityAt: new Date(),
        },
      })
    } catch (err) {
      // Race: a concurrent delivery created this sender's client first
      // (@@unique([organizationId, instagramUserId])). Append to the winner.
      if (isP2002(err)) {
        const winner = await db.client.findFirst({ where: { organizationId, instagramUserId: ev.igsid, deletedAt: null }, select: { id: true } })
        if (winner) {
          await db.note.create({ data: { clientId: winner.id, authorId: null, body: messageNote, isInternal: true } })
          await db.client.update({ where: { id: winner.id }, data: { lastActivityAt: new Date() } })
          await markSubmission({ status: 'DUPLICATE', clientId: winner.id })
          return { duplicate: false, created: false, clientId: winner.id }
        }
      }
      throw err
    }

    await db.stageHistory.create({
      data: { clientId: client.id, stageId: firstStage.id, fromKey: null, toKey: firstStage.key, automated: true, reason: `Created from ${channel}`, changedById: null },
    })
    await db.note.create({ data: { clientId: client.id, authorId: null, body: messageNote, isInternal: true } })

    // Instant Ignition — a ready-to-send bilingual reply (best-effort).
    try {
      const draft = firstTouch(firstName || '', null)
      const ignite = [
        '⚡ Instant Lead Ignition — new Instagram lead',
        '',
        `Reply fast — Instagram messagers expect a quick answer. Source: ${channel} (${label}).`,
        '',
        'Ready-to-send reply:',
        draft.en,
        '',
        'Español:',
        draft.es,
      ].join('\n')
      await db.note.create({ data: { clientId: client.id, authorId: null, body: ignite, isInternal: true, pinned: true } })
    } catch {
      // Ignition is best-effort; a failed draft never blocks the lead.
    }

    await db.auditEvent.create({
      data: {
        organizationId,
        actorId: null,
        actorLabel: 'Instagram',
        action: 'instagram.lead_created',
        entityType: 'Client',
        entityId: client.id,
        summary: `Lead created from ${channel} (${label})`,
        after: { kind: ev.kind, igsid: ev.igsid, handle, eventId: ev.eventId },
      },
    })

    await markSubmission({ status: 'APPLIED', clientId: client.id, createdClient: true })
    return { duplicate: false, created: true, clientId: client.id }
  } catch (err) {
    // A failure after the marker would otherwise block Meta's redelivery and lose
    // the lead forever — undo the marker so the redelivery re-processes it.
    await db.intakeSubmission.deleteMany({ where: { sourceId: source.id, externalId } }).catch(() => {})
    throw err
  }
}
