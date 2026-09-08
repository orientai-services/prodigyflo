import type { ConnectorDef, CredentialField } from '@/lib/connectors/catalog'

/**
 * Pure logic for the connector credential vault — masking, completeness and
 * status math with no database, no crypto and no I/O, so every rule the UI and
 * the provisioning flow rely on is unit-testable. Nothing in this module ever
 * touches plaintext credential material: it works exclusively on field KEYS and
 * stored last4 fragments, which is also everything a client VM may carry.
 */

// ── Status values (string twins of the Prisma ConnectorStatus enum) ───────────

export type ConnectorStatusValue = 'NOT_CONFIGURED' | 'MOCK' | 'CONNECTED' | 'ERROR' | 'DISABLED'

/**
 * The UI-facing state vocabulary. `ConnectorState` (in provision.ts) stays the
 * historical 5-value union because unowned surfaces key exhaustive Records off
 * it; 'mock' exists only here, split out of 'connected' for the connector hub
 * pills so a mock-mode connector is never dressed up as a live one.
 */
export type ConnectorUiState = 'available' | 'connected' | 'mock' | 'disabled' | 'error' | 'coming-soon'

/** Split the historical 'connected' state into 'connected' vs 'mock' for owned UI. */
export function displayState(
  state: 'available' | 'connected' | 'disabled' | 'error' | 'coming-soon',
  mode: 'mock' | 'live' | null,
): ConnectorUiState {
  return state === 'connected' && mode === 'mock' ? 'mock' : state
}

// ── Masking ───────────────────────────────────────────────────────────────────

/** The only rendering of a stored credential the client ever sees. */
export function maskedCredential(last4: string | null | undefined): string {
  return last4 ? `••••-${last4}` : '••••••••'
}

// ── Completeness → status ─────────────────────────────────────────────────────

export type CredentialCompletion = {
  required: string[]
  missing: string[]
  /** True only when the def takes credentials AND every field is stored. */
  complete: boolean
}

export function credentialCompletion(def: ConnectorDef, storedKeys: Iterable<string>): CredentialCompletion {
  // Optional fields enrich a connector but never gate CONNECTED (e.g. Meta's
  // Ad Account / Business Manager ids, which power the campaign manager but are
  // not needed for lead capture).
  const required = (def.credentialFields ?? []).filter((f) => !f.optional).map((f) => f.key)
  const have = new Set(storedKeys)
  const missing = required.filter((k) => !have.has(k))
  return { required, missing, complete: required.length > 0 && missing.length === 0 }
}

/**
 * The status a connector row should hold given what the vault stores for it.
 * CONNECTED requires every credential field present AND a shipped ('available')
 * def — 'coming-soon' defs bank credentials but stay MOCK until their adapter
 * lands. Deleting a required field therefore drops CONNECTED back to MOCK.
 * DISABLED/ERROR are lifecycle states owned elsewhere; callers must not
 * overwrite them with this value (see applyStatusTransition).
 */
export function nextConnectorStatus(def: ConnectorDef, storedKeys: Iterable<string>): 'CONNECTED' | 'MOCK' {
  return credentialCompletion(def, storedKeys).complete && def.availability !== 'coming-soon' ? 'CONNECTED' : 'MOCK'
}

/**
 * Whether a credential-driven status recompute may replace the current status.
 * Only the configuration states are ours to flip; DISABLED (operator intent)
 * and ERROR (health) stick until their own flows clear them.
 */
export function applyStatusTransition(
  current: ConnectorStatusValue,
  computed: 'CONNECTED' | 'MOCK',
): ConnectorStatusValue {
  if (current === 'DISABLED' || current === 'ERROR') return current
  return computed
}

// ── Outbound state mapping (pure twin of provision.ts's outboundState) ────────

export type OutboundStateInput = { isEnabled: boolean; status: ConnectorStatusValue } | null

/** Coarse state for the shared ConnectorState union ('mock' folded into 'connected'). */
export function outboundStateOf(
  connector: OutboundStateInput,
  availability: ConnectorDef['availability'],
): 'available' | 'connected' | 'disabled' | 'error' | 'coming-soon' {
  if (!connector) return availability === 'coming-soon' ? 'coming-soon' : 'available'
  if (!connector.isEnabled || connector.status === 'DISABLED') return 'disabled'
  if (connector.status === 'ERROR') return 'error'
  if (connector.status === 'NOT_CONFIGURED') return 'available'
  return 'connected' // CONNECTED or MOCK — an enabled instance exists
}

/** MOCK vs CONNECTED distinction the coarse state deliberately flattens. */
export function outboundModeOf(connector: OutboundStateInput): 'mock' | 'live' | null {
  if (!connector) return null
  if (connector.status === 'CONNECTED') return 'live'
  if (connector.status === 'MOCK') return 'mock'
  return null
}

// ── Field VMs (masked-only; safe to serialize to the client) ──────────────────

export type CredentialFieldVM = {
  key: string
  label: string
  secret: boolean
  placeholder: string | null
  configured: boolean
  /** '••••-last4' when configured, else null. Never plaintext, never ciphertext. */
  masked: string | null
  updatedLabel: string | null
}

export type StoredCredentialRow = {
  fieldKey: string
  last4: string | null
  updatedLabel?: string | null
}

/**
 * Join a def's declared credential fields to what the vault has stored,
 * producing rows that carry masked material only. Stored rows for keys the def
 * no longer declares are ignored (they still exist server-side and can be
 * cleaned up by delete). Field order follows the catalog declaration.
 */
export function buildCredentialFieldVMs(
  fields: CredentialField[] | undefined,
  stored: StoredCredentialRow[],
): CredentialFieldVM[] {
  const byKey = new Map(stored.map((r) => [r.fieldKey, r]))
  return (fields ?? []).map((f) => {
    const row = byKey.get(f.key)
    return {
      key: f.key,
      label: f.label,
      secret: f.secret,
      placeholder: f.placeholder ?? null,
      configured: row != null,
      masked: row ? maskedCredential(row.last4) : null,
      updatedLabel: row?.updatedLabel ?? null,
    }
  })
}
