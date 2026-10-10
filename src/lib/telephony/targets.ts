import 'server-only'
import { db } from '@/lib/db'
import { decryptSecret, type EncryptedSecret } from '@/lib/crypto'
import { clientScope, type SessionUser } from '@/lib/rbac'
import { readSecret } from '@/lib/call-center/contact'
import { readFacebookFormEvent } from '@/lib/call-center/meta-route'
import { maskedLast4, outboundPurpose } from './compliance-core'
import { toE164 } from './provider'
import type { ZoneHints } from './timezones'
import { canSeeCall } from './voice-calls'
import type { DialTarget, OutboundBlockCode, OutboundPurpose } from './voice-contract'

/**
 * Who is being called or texted, resolved on the SERVER from an id the browser
 * sent — the browser never supplies a number, and a rep never needs to see
 * one. Every target is scope-checked here:
 *
 *   client  in clientScope(actor)
 *   lead    in the actor's org AND locked by the actor (the desk rule)
 *   missed  a VoiceCall in the actor's org that the actor may see
 */

export type ResolvedTarget = {
  key: string
  phone: string | null
  who: string
  clientId: string | null
  leadId: string | null
  voiceCallId: string | null
  purpose: OutboundPurpose
  servicingBasis: string | null
  zoneHints: ZoneHints
}

export type TargetResult =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; code: Extract<OutboundBlockCode, 'NOT_IN_SCOPE' | 'LOCKED_BY_OTHER' | 'NO_NUMBER'>; reason: string }

export function targetKey(target: DialTarget): string {
  return `${target.kind}:${target.id}`
}

/** 'client:<id>' | 'lead:<id>' | 'missed:<id>' → DialTarget, else null. */
export function parseTargetKey(raw: string | null | undefined): DialTarget | null {
  const m = /^(client|lead|missed):([A-Za-z0-9:_-]{1,200})$/.exec((raw ?? '').trim())
  return m ? { kind: m[1] as DialTarget['kind'], id: m[2] } : null
}

const NOT_IN_SCOPE = { ok: false as const, code: 'NOT_IN_SCOPE' as const, reason: "That contact isn't in your list." }

function attributionState(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const state = (raw as { state?: unknown }).state
  return typeof state === 'string' ? state : null
}

function decryptBlob(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  try {
    return decryptSecret(value as EncryptedSecret)
  } catch {
    return null
  }
}

async function resolveClient(actor: SessionUser, id: string, now: Date, key: string): Promise<TargetResult> {
  const client = await db.client.findFirst({
    where: { AND: [clientScope(actor), { id }] },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phone: true,
      status: true,
      deletedAt: true,
      stageEnteredAt: true,
      leadAttribution: true,
      outOfArea: true,
      timeZone: true,
      currentStage: { select: { name: true, category: true } },
      addresses: { where: { isPrimary: true }, select: { state: true }, take: 1 },
    },
  })
  if (!client) return NOT_IN_SCOPE
  if (!client.phone?.trim()) return { ok: false, code: 'NO_NUMBER', reason: 'This client has no phone number on file.' }
  const purpose = outboundPurpose(
    {
      deletedAt: client.deletedAt,
      status: client.status,
      stageCategory: client.currentStage.category,
      stageName: client.currentStage.name,
      stageEnteredAt: client.stageEnteredAt,
    },
    now,
  )
  const e164 = toE164(client.phone)
  return {
    ok: true,
    target: {
      key,
      phone: client.phone,
      who: `${client.firstName} ${client.lastName}`.trim(),
      clientId: client.id,
      leadId: null,
      voiceCallId: null,
      purpose: purpose.purpose,
      servicingBasis: purpose.basis,
      zoneHints: {
        leadZone: client.timeZone,
        states: [attributionState(client.leadAttribution), client.addresses[0]?.state ?? null],
        e164,
        outOfArea: client.outOfArea,
      },
    },
  }
}

function leadName(events: { type: string; body: string }[]): string | null {
  for (const e of events) {
    if (e.type !== 'FORM') continue
    const read = readFacebookFormEvent(e.body)
    if (read.name) return read.name
  }
  return null
}

async function resolveLead(actor: SessionUser, id: string, key: string, requireLock: boolean): Promise<TargetResult> {
  const lead = await db.callCenterLead.findFirst({
    where: { id, organizationId: actor.organizationId },
    select: {
      id: true,
      lockedBy: true,
      phoneSecret: true,
      phoneLast4: true,
      timeZone: true,
      leadAttribution: true,
      outOfArea: true,
      events: { where: { type: 'FORM' }, select: { type: true, body: true }, take: 1 },
    },
  })
  if (!lead) return NOT_IN_SCOPE
  if (requireLock && lead.lockedBy !== actor.id) {
    return lead.lockedBy
      ? { ok: false, code: 'LOCKED_BY_OTHER', reason: 'Another rep has this lead.' }
      : { ok: false, code: 'NOT_IN_SCOPE', reason: 'Take this lead first.' }
  }
  const phone = readSecret(lead.phoneSecret)
  if (!phone) return { ok: false, code: 'NO_NUMBER', reason: 'This lead has no phone number on file.' }
  const e164 = toE164(phone)
  return {
    ok: true,
    target: {
      key,
      phone,
      who: leadName(lead.events) ?? maskedLast4(phone),
      clientId: null,
      leadId: lead.id,
      voiceCallId: null,
      purpose: 'marketing',
      servicingBasis: null,
      zoneHints: { leadZone: lead.timeZone, states: [attributionState(lead.leadAttribution)], e164, outOfArea: lead.outOfArea },
    },
  }
}

export async function resolveDialTarget(actor: SessionUser, target: DialTarget, now = new Date()): Promise<TargetResult> {
  const key = targetKey(target)
  if (target.kind === 'client') return resolveClient(actor, target.id, now, key)
  if (target.kind === 'lead') return resolveLead(actor, target.id, key, true)

  const vc = await db.voiceCall.findFirst({ where: { id: target.id, organizationId: actor.organizationId } })
  if (!vc || !(await canSeeCall(actor, vc))) return NOT_IN_SCOPE
  if (vc.clientId) {
    const asClient = await resolveClient(actor, vc.clientId, now, key)
    if (asClient.ok) return { ok: true, target: { ...asClient.target, voiceCallId: vc.id } }
  }
  const phone = decryptBlob(vc.remoteSecret)
  if (!phone) return { ok: false, code: 'NO_NUMBER', reason: "We don't have this caller's number." }
  if (vc.callCenterLeadId) {
    // Calling back a missed caller is not a desk claim, so no lock is needed;
    // the lead's own consent (their call, 90 days) and do-not-call still apply.
    const asLead = await resolveLead(actor, vc.callCenterLeadId, key, false)
    if (asLead.ok) return { ok: true, target: { ...asLead.target, phone, voiceCallId: vc.id } }
  }
  return {
    ok: true,
    target: {
      key,
      phone,
      who: maskedLast4(phone),
      clientId: null,
      leadId: null,
      voiceCallId: vc.id,
      purpose: 'marketing',
      servicingBasis: null,
      zoneHints: { e164: toE164(phone) },
    },
  }
}
