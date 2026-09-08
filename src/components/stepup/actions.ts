'use server'

import bcrypt from 'bcryptjs'
import { recordAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/rbac'
import { grantStepUp, type PasswordStepUpScope } from '@/lib/stepup'

export type StepUpState = { error?: string; granted?: boolean }

// Matches the dummy-hash equalizer in src/lib/auth.ts: when the user row is
// gone (deactivated mid-session), the compare still runs so timing is uniform.
const DUMMY_HASH = '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu'

const BURST_WINDOW_MS = 5 * 60 * 1000
const BURST_MAX = 5

/**
 * Re-confirms the signed-in user's password and issues a 10-minute step-up
 * grant for one scope. A server action is a public POST endpoint, so this
 * re-checks the session itself and rate-limits by counting its own denial
 * audit rows — a refused attempt also writes one, so hammering extends the
 * lockout rather than resetting it. Audits carry the scope only, never the
 * password or any credential material.
 */
export async function confirmPasswordAction(
  _prev: StepUpState,
  formData: FormData,
): Promise<StepUpState> {
  const user = await getSessionUser()
  if (!user) return { error: 'Your session has expired. Sign in again.' }

  const scopeRaw = formData.get('scope')
  if (scopeRaw !== 'vault' && scopeRaw !== 'deploy') return { error: 'Unknown step-up scope.' }
  const scope: PasswordStepUpScope = scopeRaw

  const password = formData.get('password')
  if (typeof password !== 'string' || password.length === 0) {
    return { error: 'Enter your password.' }
  }

  const recentDenials = await db.auditEvent.count({
    where: {
      organizationId: user.organizationId,
      actorId: user.id,
      action: 'stepup.denied',
      createdAt: { gte: new Date(Date.now() - BURST_WINDOW_MS) },
    },
  })
  if (recentDenials >= BURST_MAX) {
    await recordAudit(user, {
      action: 'stepup.denied',
      entityType: 'User',
      entityId: user.id,
      summary: `Step-up for ${scope} rate limited`,
      after: { scope, reason: 'rate_limited' },
    })
    return { error: 'Too many failed attempts. Wait a few minutes and try again.' }
  }

  // The hash is fetched fresh — never trusted from the session — so a password
  // change or deactivation since sign-in takes effect immediately.
  const record = await db.user.findFirst({
    where: { id: user.id, isActive: true, deletedAt: null },
    select: { passwordHash: true },
  })
  const ok = await bcrypt.compare(password, record?.passwordHash ?? DUMMY_HASH)

  if (!record || !ok) {
    await recordAudit(user, {
      action: 'stepup.denied',
      entityType: 'User',
      entityId: user.id,
      summary: `Step-up for ${scope} denied — password check failed`,
      after: { scope, reason: 'bad_password' },
    })
    return { error: 'That password is not correct.' }
  }

  await grantStepUp(user, scope)
  await recordAudit(user, {
    action: 'stepup.granted',
    entityType: 'User',
    entityId: user.id,
    summary: `Step-up granted for ${scope}`,
    after: { scope },
  })
  return { granted: true }
}
