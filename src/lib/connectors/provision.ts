import { Prisma, type Connector, type IntakeSource } from '@prisma/client'
import { db } from '@/lib/db'
import { ForbiddenError, requirePermission, type SessionUser } from '@/lib/rbac'
import { recordAudit } from '@/lib/audit'
import { encryptSecret, secretLast4 } from '@/lib/crypto'
import { requireStepUp, StepUpRequiredError } from '@/lib/stepup'
import {
  applyStatusTransition,
  nextConnectorStatus,
  outboundModeOf,
  outboundStateOf,
  type ConnectorStatusValue,
} from '@/lib/connectors/credential-logic'
import { generateIntakeSecret, hashIntakeSecret } from '@/lib/intake/hmac'
import {
  applyMapping,
  missingRequiredFields,
  type MappedLead,
} from '@/lib/intake/mapping'
import {
  CONNECTORS,
  connectorDef,
  isInbound,
  type ConnectorDef,
} from '@/lib/connectors/catalog'

/**
 * Provisioning + status for the Connectors hub. The hub is one card per catalog
 * def; this module joins each def to whatever the org has actually stored
 * (an IntakeSource for inbound defs, a Connector for outbound ones), mints the
 * inbound HMAC secret via the shared intake helpers, and previews a field
 * mapping against a payload without touching the database.
 *
 * NOT marked `server-only`: `testMapping`/`testMappingCore` are pure and safe to
 * import anywhere. The db-backed functions are only ever invoked server-side.
 */

// ── Shared contract types ─────────────────────────────────────────────────────

export type ConnectorState = 'available' | 'connected' | 'disabled' | 'error' | 'coming-soon'

export type ConnectorHealth = {
  ok: boolean
  lastAt: Date | null
  detail: string | null
}

export type ConnectorInstance = {
  def: ConnectorDef
  state: ConnectorState
  /**
   * Outbound only: distinguishes a MOCK row from a truly CONNECTED one —
   * `state` folds both into 'connected' because unowned surfaces key
   * exhaustive Records off ConnectorState. UI that owns its pills renders
   * displayState(state, mode) from credential-logic instead.
   */
  mode: 'mock' | 'live' | null
  /** IntakeSource.id or Connector.id — null when nothing is stored yet. */
  instanceId: string | null
  name: string | null
  health: ConnectorHealth
  submissionCount?: number
}

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string }

/** Default mapping applied when an inbound def ships no preset — mirrors createIntakeSource. */
const DEFAULT_FIELD_MAPPING: Record<string, string> = {
  firstName: 'first_name',
  lastName: 'last_name',
  email: 'email',
  phone: 'phone',
}

// ── Permission gate (matches settings/intake/actions.ts) ──────────────────────

async function manage(): Promise<SessionUser | null> {
  try {
    return await requirePermission('connectors:manage')
  } catch (e) {
    if (e instanceof ForbiddenError) return null
    throw e
  }
}

const FORBIDDEN = { ok: false as const, error: 'You do not have permission to manage connectors.' }

// ── Base URL helper ───────────────────────────────────────────────────────────

/** Origin the signed webhooks live under, e.g. https://prodigyflo.ai (no trailing slash). */
export function webhookBaseUrl(): string {
  const raw = process.env.AUTH_URL || process.env.NEXTAUTH_URL || ''
  return raw.replace(/\/+$/, '')
}

function webhookPathFor(slug: string): string {
  return `/api/intake/${slug}`
}

// ── Status ─────────────────────────────────────────────────────────────────────

function inboundState(source: IntakeSource | null, def: ConnectorDef): ConnectorState {
  if (!source) return def.availability === 'coming-soon' ? 'coming-soon' : 'available'
  if (!source.isEnabled) return 'disabled'
  if (source.lastError || source.lastSyncStatus === 'error') return 'error'
  return 'connected'
}

function outboundState(connector: Connector | null, def: ConnectorDef): ConnectorState {
  return outboundStateOf(connector, def.availability)
}

/**
 * Every catalog def joined to its stored instance (if any), org-scoped.
 * Inbound defs match a stored IntakeSource by connectorDefId, else by kind for
 * legacy rows that predate the catalog stamp; outbound defs match a Connector by kind.
 */
export async function listConnectorStatus(user: SessionUser): Promise<ConnectorInstance[]> {
  const [sources, connectors] = await Promise.all([
    db.intakeSource.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: 'asc' },
    }),
    db.connector.findMany({ where: { organizationId: user.organizationId } }),
  ])

  const out: ConnectorInstance[] = []
  for (const def of CONNECTORS) {
    if (isInbound(def)) {
      const candidates = sources.filter(
        (s) => s.connectorDefId === def.id || (!s.connectorDefId && s.kind === def.backing.kind),
      )
      const source = candidates.find((s) => s.isEnabled) ?? candidates[0] ?? null

      if (!source) {
        out.push({
          def,
          state: inboundState(null, def),
          mode: null,
          instanceId: null,
          name: null,
          health: { ok: true, lastAt: null, detail: null },
        })
        continue
      }

      const [submissionCount, latest] = await Promise.all([
        db.intakeSubmission.count({ where: { sourceId: source.id } }),
        db.intakeSubmission.findFirst({
          where: { sourceId: source.id },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
      ])

      out.push({
        def,
        state: inboundState(source, def),
        mode: null,
        instanceId: source.id,
        name: source.name,
        health: {
          ok: !source.lastError && source.lastSyncStatus !== 'error',
          lastAt: latest?.createdAt ?? source.lastSyncAt ?? null,
          detail: source.lastError ?? source.lastSyncStatus ?? null,
        },
        submissionCount,
      })
    } else {
      const connector = connectors.find((c) => c.kind === def.backing.kind) ?? null
      out.push({
        def,
        state: outboundState(connector, def),
        mode: outboundModeOf(connector),
        instanceId: connector?.id ?? null,
        name: connector?.name ?? null,
        health: {
          ok: connector ? connector.webhookHealthy && connector.status !== 'ERROR' : true,
          lastAt: connector?.lastSyncAt ?? null,
          detail: connector?.lastError ?? connector?.status ?? null,
        },
      })
    }
  }
  return out
}

// ── Connect ────────────────────────────────────────────────────────────────────

function slugifyBase(def: ConnectorDef, name: string): string {
  const raw = (def.id || name || 'source').toLowerCase()
  let s = raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56)
  if (s.length < 3) s = `${s}-src`.slice(0, 56)
  return s
}

async function uniqueSlug(organizationId: string, base: string, taken: Set<string>): Promise<string> {
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  // Practically unreachable; fall back to a timestamped suffix.
  return `${base}-${Date.now().toString(36)}`
}

/**
 * Provision a connector. Inbound defs are the primary path: create an IntakeSource
 * with the def's fieldPreset as the initial mapping, connectorDefId stamped, and a
 * freshly minted HMAC secret returned exactly once. Outbound defs either report
 * coming-soon or create/enable a Connector row in MOCK mode.
 */
export async function connectInbound(
  user: SessionUser,
  input: { defId: string; name?: string },
): Promise<Result<{ sourceId: string; slug: string; secret: string; webhookPath: string }>> {
  const actor = await manage()
  if (!actor) return FORBIDDEN

  const def = connectorDef(input.defId)
  if (!def) return { ok: false, error: 'Unknown connector.' }

  const name = (input.name ?? '').trim() || def.name

  // Outbound defs have their own path — no slug, no signing secret, and a
  // credential vault instead of a webhook. Route them to connectOutbound.
  if (def.backing.model === 'connector') {
    return { ok: false, error: `${def.name} is an outbound service — enable it from its connector page instead.` }
  }

  // Managed inbound defs are provisioned automatically by a dedicated webhook
  // route, not by self-serve Connect — a per-source signing secret would be
  // meaningless (Meta signs with the app secret), and connecting would orphan a
  // duplicate source the webhook never uses.
  if (def.managed) {
    return { ok: false, error: `${def.name} is set up automatically through its Meta webhook — no manual connect needed.` }
  }

  // ── Inbound (IntakeSource) ──
  const secret = generateIntakeSecret()
  const fieldMapping: Record<string, string> = def.fieldPreset
    ? { ...(def.fieldPreset as Record<string, string>) }
    : { ...DEFAULT_FIELD_MAPPING }

  const existing = new Set(
    (await db.intakeSource.findMany({ where: { organizationId: actor.organizationId }, select: { slug: true } })).map(
      (r) => r.slug,
    ),
  )
  const base = slugifyBase(def, name)

  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = await uniqueSlug(actor.organizationId, base, existing)
    try {
      const source = await db.intakeSource.create({
        data: {
          organizationId: actor.organizationId,
          kind: def.backing.kind,
          connectorDefId: def.id,
          name,
          slug,
          authMode: def.auth === 'webhook-token' ? 'TOKEN' : 'HMAC',
          secretHash: hashIntakeSecret(secret),
          fieldMapping,
        },
      })
      await recordAudit(actor, {
        action: 'connector.connected',
        entityType: 'IntakeSource',
        entityId: source.id,
        summary: `Connected "${source.name}" (${def.id}) — ${webhookPathFor(source.slug)}`,
      })
      return { ok: true, sourceId: source.id, slug: source.slug, secret, webhookPath: webhookPathFor(source.slug) }
    } catch (e) {
      // Lost a slug race — mark it taken and try the next suffix.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        existing.add(slug)
        continue
      }
      throw e
    }
  }
  return { ok: false, error: 'Could not allocate a unique webhook slug. Try a different name.' }
}

// ── Enable / disable ────────────────────────────────────────────────────────────

export async function setConnectorEnabled(
  user: SessionUser,
  input: { instanceId: string; model: 'intakeSource' | 'connector'; enabled: boolean },
): Promise<Result> {
  const actor = await manage()
  if (!actor) return FORBIDDEN

  if (input.model === 'intakeSource') {
    const source = await db.intakeSource.findFirst({
      where: { id: input.instanceId, organizationId: actor.organizationId },
    })
    if (!source) return { ok: false, error: 'Connector not found.' }
    await db.intakeSource.update({ where: { id: source.id }, data: { isEnabled: input.enabled } })
    await recordAudit(actor, {
      action: 'connector.toggled',
      entityType: 'IntakeSource',
      entityId: source.id,
      summary: `${input.enabled ? 'Enabled' : 'Disabled'} connector "${source.name}"`,
    })
    return { ok: true }
  }

  const connector = await db.connector.findFirst({
    where: { id: input.instanceId, organizationId: actor.organizationId },
  })
  if (!connector) return { ok: false, error: 'Connector not found.' }
  await db.connector.update({
    where: { id: connector.id },
    data: {
      isEnabled: input.enabled,
      ...(input.enabled ? {} : { status: 'DISABLED' as const }),
      ...(input.enabled && connector.status === 'DISABLED' ? { status: 'MOCK' as const } : {}),
    },
  })
  await recordAudit(actor, {
    action: 'connector.toggled',
    entityType: 'Connector',
    entityId: connector.id,
    summary: `${input.enabled ? 'Enabled' : 'Disabled'} connector "${connector.name}"`,
  })
  return { ok: true }
}

// ── Outbound connect ───────────────────────────────────────────────────────────

/**
 * Enable an outbound service. No slug, no signing secret — this upserts the
 * org's Connector row for the def's kind in MOCK mode (or re-enables a disabled
 * one). Works for 'coming-soon' defs too: they can bank credentials in the
 * vault today and stay in mock mode until their adapter ships.
 */
export async function connectOutbound(
  user: SessionUser,
  input: { defId: string; name?: string },
): Promise<Result<{ connectorId: string }>> {
  const actor = await manage()
  if (!actor) return FORBIDDEN

  const def = connectorDef(input.defId)
  if (!def) return { ok: false, error: 'Unknown connector.' }
  if (def.backing.model !== 'connector') {
    return { ok: false, error: `${def.name} is an inbound source — connect it from the catalog instead.` }
  }

  const kind = def.backing.kind
  const name = (input.name ?? '').trim() || def.name
  const existing = await db.connector.findUnique({
    where: { organizationId_kind: { organizationId: actor.organizationId, kind } },
    select: { status: true },
  })
  const connector = await db.connector.upsert({
    where: { organizationId_kind: { organizationId: actor.organizationId, kind } },
    create: {
      organizationId: actor.organizationId,
      kind,
      name,
      status: 'MOCK',
      isEnabled: true,
    },
    // Re-enabling a DISABLED row goes back to MOCK; a CONNECTED one stays live.
    update: { isEnabled: true, name, ...(existing?.status === 'DISABLED' ? { status: 'MOCK' as const } : {}) },
  })
  await recordAudit(actor, {
    action: 'connector.connected',
    entityType: 'Connector',
    entityId: connector.id,
    summary: `Connected "${connector.name}" (${def.id}) in ${connector.status === 'CONNECTED' ? 'live' : 'mock'} mode`,
  })
  return { ok: true, connectorId: connector.id }
}

// ── Credential vault (encrypted, write-only) ──────────────────────────────────

const STEP_UP_REQUIRED = {
  ok: false as const,
  error: 'Confirm your password to manage credentials — your secure window has expired.',
}

type VaultDef = ConnectorDef & { backing: { model: 'connector'; kind: Connector['kind'] } }

/** Resolve + validate a def that takes vault credentials. */
function vaultDef(defId: string): VaultDef | null {
  const def = connectorDef(defId)
  if (!def || def.backing.model !== 'connector' || !def.credentialFields?.length) return null
  return def as VaultDef
}

/** connectors:manage AND a fresh 'vault' step-up grant — both, or a typed refusal. */
async function vaultActor(): Promise<{ actor: SessionUser } | { refusal: typeof FORBIDDEN | typeof STEP_UP_REQUIRED }> {
  const actor = await manage()
  if (!actor) return { refusal: FORBIDDEN }
  try {
    await requireStepUp(actor, 'vault')
  } catch (e) {
    if (e instanceof StepUpRequiredError) return { refusal: STEP_UP_REQUIRED }
    throw e
  }
  return { actor }
}

/**
 * Recompute and persist the connector's status from what the vault now stores:
 * CONNECTED only when every declared field is present and the def has shipped;
 * otherwise MOCK. DISABLED/ERROR are never overwritten (operator/health states).
 * Returns the status the row holds after the recompute.
 */
async function refreshConnectorStatus(connectorId: string, def: VaultDef): Promise<ConnectorStatusValue> {
  const [row, creds] = await Promise.all([
    db.connector.findUniqueOrThrow({ where: { id: connectorId }, select: { status: true } }),
    db.connectorCredential.findMany({ where: { connectorId }, select: { fieldKey: true } }),
  ])
  const current = row.status as ConnectorStatusValue
  const next = applyStatusTransition(current, nextConnectorStatus(def, creds.map((c) => c.fieldKey)))
  if (next !== current) {
    await db.connector.update({ where: { id: connectorId }, data: { status: next } })
  }
  return next
}

/**
 * Store (create or replace) credential values for an outbound connector.
 * Values are encrypted before they touch the database; only last4 is kept
 * readable, for masked UI rows. Blank values are skipped — "leave blank to
 * keep the stored value" is the whole write-only contract. Audits and
 * ConnectorLog rows carry field KEYS only, never credential material.
 */
export async function saveConnectorCredentials(
  user: SessionUser,
  input: { defId: string; values: Record<string, string> },
): Promise<Result<{ status: ConnectorStatusValue; savedFields: string[] }>> {
  const gate = await vaultActor()
  if ('refusal' in gate) return gate.refusal
  const { actor } = gate

  const def = vaultDef(input.defId)
  if (!def) return { ok: false, error: 'This connector does not take credentials.' }

  const allowed = new Set((def.credentialFields ?? []).map((f) => f.key))
  const entries = Object.entries(input.values ?? {})
    .map(([k, v]) => [k, typeof v === 'string' ? v.trim() : ''] as const)
    .filter(([k, v]) => allowed.has(k) && v.length > 0)
  if (entries.length === 0) return { ok: false, error: 'Nothing to save — all fields were blank.' }

  const connector = await db.connector.upsert({
    where: { organizationId_kind: { organizationId: actor.organizationId, kind: def.backing.kind } },
    create: {
      organizationId: actor.organizationId,
      kind: def.backing.kind,
      name: def.name,
      status: 'MOCK',
      isEnabled: true,
    },
    update: {},
  })

  for (const [fieldKey, value] of entries) {
    const enc = encryptSecret(value)
    const material = {
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      keyVersion: enc.keyVersion,
      last4: secretLast4(value),
      createdById: actor.id,
    }
    await db.connectorCredential.upsert({
      where: { connectorId_fieldKey: { connectorId: connector.id, fieldKey } },
      create: { organizationId: actor.organizationId, connectorId: connector.id, fieldKey, ...material },
      update: material,
    })
  }

  const status = await refreshConnectorStatus(connector.id, def)
  const savedFields = entries.map(([k]) => k)
  await db.connectorLog.create({
    data: { connectorId: connector.id, event: 'credentials.saved', detail: { fields: savedFields, status } },
  })
  await recordAudit(actor, {
    action: 'connector.credentials_saved',
    entityType: 'Connector',
    entityId: connector.id,
    summary: `Saved ${savedFields.length} credential field${savedFields.length === 1 ? '' : 's'} for ${def.name} (${savedFields.join(', ')})`,
    after: { fields: savedFields, status },
  })
  return { ok: true, status, savedFields }
}

/**
 * Replace one already-stored credential value. Same encryption path as save,
 * but refuses when nothing is stored yet — rotation is an explicit intent and
 * the audit trail should say so.
 */
export async function rotateConnectorCredential(
  user: SessionUser,
  input: { defId: string; fieldKey: string; value: string },
): Promise<Result<{ status: ConnectorStatusValue }>> {
  const gate = await vaultActor()
  if ('refusal' in gate) return gate.refusal
  const { actor } = gate

  const def = vaultDef(input.defId)
  if (!def) return { ok: false, error: 'This connector does not take credentials.' }
  const field = (def.credentialFields ?? []).find((f) => f.key === input.fieldKey)
  if (!field) return { ok: false, error: 'Unknown credential field.' }
  const value = (input.value ?? '').trim()
  if (!value) return { ok: false, error: 'Enter the new value to rotate to.' }

  const connector = await db.connector.findUnique({
    where: { organizationId_kind: { organizationId: actor.organizationId, kind: def.backing.kind } },
    select: { id: true },
  })
  if (!connector) return { ok: false, error: 'Nothing stored for this connector yet — save the field first.' }

  const enc = encryptSecret(value)
  const updated = await db.connectorCredential.updateMany({
    where: { connectorId: connector.id, fieldKey: field.key },
    data: {
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      keyVersion: enc.keyVersion,
      last4: secretLast4(value),
      createdById: actor.id,
    },
  })
  if (updated.count === 0) {
    return { ok: false, error: 'Nothing stored for this field yet — save it first.' }
  }

  const status = await refreshConnectorStatus(connector.id, def)
  await db.connectorLog.create({
    data: { connectorId: connector.id, event: 'credentials.rotated', detail: { field: field.key } },
  })
  await recordAudit(actor, {
    action: 'connector.credential_rotated',
    entityType: 'Connector',
    entityId: connector.id,
    summary: `Rotated the ${field.label} credential for ${def.name}`,
    after: { field: field.key },
  })
  return { ok: true, status }
}

/**
 * Remove one stored credential value. Dropping a required field pulls a
 * CONNECTED connector back to MOCK — live sending must never continue on a
 * partially deleted credential set.
 */
export async function deleteConnectorCredential(
  user: SessionUser,
  input: { defId: string; fieldKey: string },
): Promise<Result<{ status: ConnectorStatusValue }>> {
  const gate = await vaultActor()
  if ('refusal' in gate) return gate.refusal
  const { actor } = gate

  const def = vaultDef(input.defId)
  if (!def) return { ok: false, error: 'This connector does not take credentials.' }

  const connector = await db.connector.findUnique({
    where: { organizationId_kind: { organizationId: actor.organizationId, kind: def.backing.kind } },
    select: { id: true },
  })
  if (!connector) return { ok: false, error: 'Nothing stored for this connector.' }

  const deleted = await db.connectorCredential.deleteMany({
    where: { connectorId: connector.id, fieldKey: input.fieldKey },
  })
  if (deleted.count === 0) return { ok: false, error: 'Nothing stored for this field.' }

  const status = await refreshConnectorStatus(connector.id, def)
  const label = (def.credentialFields ?? []).find((f) => f.key === input.fieldKey)?.label ?? input.fieldKey
  await db.connectorLog.create({
    data: { connectorId: connector.id, event: 'credentials.deleted', detail: { field: input.fieldKey, status } },
  })
  await recordAudit(actor, {
    action: 'connector.credential_deleted',
    entityType: 'Connector',
    entityId: connector.id,
    summary: `Removed the ${label} credential for ${def.name}${status === 'MOCK' ? ' — connector dropped back to mock mode' : ''}`,
    after: { field: input.fieldKey, status },
  })
  return { ok: true, status }
}

// ── Mapping tester (pure) ────────────────────────────────────────────────────────

function isConnectorDef(v: ConnectorDef | Record<string, string>): v is ConnectorDef {
  return typeof (v as ConnectorDef).backing === 'object' && (v as ConnectorDef).backing !== null
}

/**
 * Pure core of the live mapping tester: run a field mapping (or a def's preset)
 * against a payload object and report what maps, what required fields are still
 * missing, and which incoming keys nothing consumed. No database, no I/O.
 */
export function testMappingCore(
  defOrMapping: ConnectorDef | Record<string, string>,
  payload: unknown,
): { mapped: MappedLead; missingRequired: string[]; unmappedKeys: string[] } {
  const fieldMapping = isConnectorDef(defOrMapping)
    ? ((defOrMapping.fieldPreset ?? {}) as Record<string, string>)
    : defOrMapping
  const { mapped, unmappedKeys } = applyMapping(fieldMapping, payload)
  return { mapped, missingRequired: missingRequiredFields(mapped), unmappedKeys }
}

/**
 * UI-facing wrapper: parse a JSON string, then run `testMappingCore`. An empty
 * mapping falls back to the def's preset so the tester works before any edits.
 */
export function testMapping(
  defId: string,
  fieldMapping: Record<string, string>,
  payloadJson: string,
): { ok: true; mapped: MappedLead; missingRequired: string[]; unmappedKeys: string[] } | { ok: false; error: string } {
  let payload: unknown
  try {
    payload = JSON.parse(payloadJson)
  } catch {
    return { ok: false, error: 'Payload is not valid JSON.' }
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, error: 'Payload must be a JSON object.' }
  }
  const def = connectorDef(defId)
  const mapping =
    fieldMapping && Object.keys(fieldMapping).length > 0 ? fieldMapping : ((def?.fieldPreset ?? {}) as Record<string, string>)
  return { ok: true, ...testMappingCore(mapping, payload) }
}
