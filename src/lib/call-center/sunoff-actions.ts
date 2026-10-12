'use server'

import { requireUser } from '@/lib/rbac'
import {
  provisionSunoffUserFor,
  refreshSunoffHandoffFor,
  startSunoffHandoffFor,
  sunoffHandoffStateFor,
  type HandoffResult,
  type HandoffState,
  type ProvisionResult,
} from '@/lib/sunoff-bridge/handoff'

/**
 * Desk server actions for "CYS Sign up" (docs/CYS_BRIDGE.md §B3). The screen
 * calls these; every SunOff request, URL and key stays on the server.
 *
 * On `ok: true`, navigate the tab opened inside the click to `url` (a
 * one-time SunOff sign-in link, valid 10 minutes).
 */

/** Requires the lead's lock (or Super Admin) and a linked Client. */
export async function startSunoffHandoff(leadId: string): Promise<HandoffResult> {
  const user = await requireUser()
  return startSunoffHandoffFor(user, leadId)
}

/** "Re-send profile": sends the current revision even when SunOff already has one. */
export async function refreshSunoffHandoff(leadId: string): Promise<HandoffResult> {
  const user = await requireUser()
  return refreshSunoffHandoffFor(user, leadId)
}

/** Null until the lead was first sent. `stale` = the Client changed after the last send. */
export async function sunoffHandoffState(leadId: string): Promise<HandoffState> {
  const user = await requireUser()
  return sunoffHandoffStateFor(user, leadId)
}

/** Decision D2: create or link the signed-in user's SunOff account (shown after NO_SUNOFF_USER). */
export async function provisionSunoffUser(): Promise<ProvisionResult> {
  const user = await requireUser()
  return provisionSunoffUserFor(user)
}
