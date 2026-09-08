'use server'

import { revalidatePath } from 'next/cache'
import { ForbiddenError, requirePermission, type SessionUser } from '@/lib/rbac'
import {
  connectInbound,
  connectOutbound,
  deleteConnectorCredential,
  rotateConnectorCredential,
  saveConnectorCredentials,
  setConnectorEnabled,
  testMapping,
} from '@/lib/connectors/provision'
import { runGhlImportBatch, type GhlImportRunResult } from '@/lib/connectors/ghl-import'
import { requireStepUp, StepUpRequiredError, type StepUpScope } from '@/lib/stepup'
import { rotateIntakeSecret } from '../intake/actions'

/**
 * Thin server-action wrappers over the connectors backend (src/lib/connectors/provision.ts)
 * and the existing intake secret-rotation action. Every action re-checks permission
 * server-side — a server action is a public POST endpoint, so the page gate never
 * protects it. The backend functions ALSO gate internally (defense in depth).
 */

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string }

const FORBIDDEN = { ok: false as const, error: 'You do not have permission to manage connectors.' }

async function requireManage(): Promise<SessionUser | null> {
  try {
    return await requirePermission('connectors:manage')
  } catch (e) {
    if (e instanceof ForbiddenError) return null
    throw e
  }
}

/**
 * Step-up check for the credential vault, AFTER the permission gate. The
 * <StepUpGate> around the credentials card is UX only — this call in the
 * action itself is the security boundary. Returns the refusal Result (instead
 * of throwing) so useActionState surfaces it like every other error.
 */
async function requireVaultStepUp(
  user: SessionUser,
  scope: StepUpScope = 'vault',
): Promise<{ ok: false; error: string } | null> {
  try {
    await requireStepUp(user, scope)
    return null
  } catch (e) {
    if (e instanceof StepUpRequiredError) return { ok: false, error: e.message }
    throw e
  }
}

// ── Connect ──────────────────────────────────────────────────────────────────

export async function connectConnector(input: {
  defId: string
  name: string
}): Promise<Result<{ sourceId: string; slug: string; secret: string; webhookPath: string }>> {
  const user = await requireManage()
  if (!user) return FORBIDDEN
  const res = await connectInbound(user, input)
  if (res.ok) {
    revalidatePath('/settings/connectors')
    revalidatePath(`/settings/connectors/${input.defId}`)
    revalidatePath('/settings/intake')
  }
  return res
}

// ── Enable / disable ───────────────────────────────────────────────────────────

export async function toggleConnector(input: {
  instanceId: string
  model: 'intakeSource' | 'connector'
  enabled: boolean
  defId: string
}): Promise<Result> {
  const user = await requireManage()
  if (!user) return FORBIDDEN
  const res = await setConnectorEnabled(user, {
    instanceId: input.instanceId,
    model: input.model,
    enabled: input.enabled,
  })
  if (res.ok) {
    revalidatePath('/settings/connectors')
    revalidatePath(`/settings/connectors/${input.defId}`)
  }
  return res
}

// ── Secret rotation (reuses the intake action, which gates on connectors:manage) ──

export async function rotateConnectorSecret(input: {
  sourceId: string
  defId: string
}): Promise<Result<{ secret: string }> | { ok: false; error?: string }> {
  const res = await rotateIntakeSecret(input.sourceId)
  if (res.ok) {
    revalidatePath(`/settings/connectors/${input.defId}`)
    revalidatePath('/settings/intake')
  }
  return res
}

// ── Live mapping tester (read-gated; pure server compute) ─────────────────────

export async function testConnectorMapping(input: {
  defId: string
  fieldMapping: Record<string, string>
  payloadJson: string
}) {
  try {
    await requirePermission('connectors:read')
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false as const, error: 'You do not have permission to view connectors.' }
    throw e
  }
  return testMapping(input.defId, input.fieldMapping, input.payloadJson)
}

// ── Outbound connect (creates/enables the Connector row in mock mode) ─────────

export async function connectOutboundConnector(input: {
  defId: string
  name?: string
}): Promise<Result<{ connectorId: string }>> {
  const user = await requireManage()
  if (!user) return FORBIDDEN
  const res = await connectOutbound(user, input)
  if (res.ok) {
    revalidatePath('/settings/connectors')
    revalidatePath(`/settings/connectors/${input.defId}`)
  }
  return res
}

// ── GoHighLevel pull import (bounded batch; the card re-invokes until done) ───

export async function runGhlImportAction(): Promise<GhlImportRunResult> {
  const user = await requireManage()
  if (!user) return FORBIDDEN
  const res = await runGhlImportBatch(user)
  if (res.ok && res.done) {
    revalidatePath('/settings/connectors')
    revalidatePath('/settings/connectors/gohighlevel-api')
    revalidatePath('/clients')
    revalidatePath('/inbound')
  }
  return res
}

// ── Credential vault (permission gate + step-up gate on EVERY action) ─────────

export async function saveConnectorCredentialsAction(input: {
  defId: string
  values: Record<string, string>
}): Promise<Result<{ status: string; savedFields: string[] }>> {
  const user = await requireManage()
  if (!user) return FORBIDDEN
  const stepUp = await requireVaultStepUp(user)
  if (stepUp) return stepUp
  const res = await saveConnectorCredentials(user, input)
  if (res.ok) {
    revalidatePath('/settings/connectors')
    revalidatePath(`/settings/connectors/${input.defId}`)
  }
  return res
}

export async function rotateConnectorCredentialAction(input: {
  defId: string
  fieldKey: string
  value: string
}): Promise<Result<{ status: string }>> {
  const user = await requireManage()
  if (!user) return FORBIDDEN
  const stepUp = await requireVaultStepUp(user)
  if (stepUp) return stepUp
  const res = await rotateConnectorCredential(user, input)
  if (res.ok) {
    revalidatePath('/settings/connectors')
    revalidatePath(`/settings/connectors/${input.defId}`)
  }
  return res
}

export async function deleteConnectorCredentialAction(input: {
  defId: string
  fieldKey: string
}): Promise<Result<{ status: string }>> {
  const user = await requireManage()
  if (!user) return FORBIDDEN
  const stepUp = await requireVaultStepUp(user)
  if (stepUp) return stepUp
  const res = await deleteConnectorCredential(user, input)
  if (res.ok) {
    revalidatePath('/settings/connectors')
    revalidatePath(`/settings/connectors/${input.defId}`)
  }
  return res
}
