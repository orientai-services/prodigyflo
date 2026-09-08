'use server'

import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/rbac'
import { recordAudit } from '@/lib/audit'
import { hashValue, maskEmail } from '@/lib/crypto'
import {
  AUTH_BURST_WINDOW_MS,
  burstAllowsIssue,
  invalidateAllAuthTokens,
  issueAuthToken,
  passwordPolicyError,
} from '@/lib/auth-tokens'
import { sendPasswordResetEmail } from '@/lib/auth-mail'
import { emailRoutingConfigured, removeForwardingRule, syncForwarding } from '@/lib/email-routing'

export type ProfileState = { error?: string; ok?: string }

const identitySchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name.').max(80),
  nickname: z.string().trim().max(40).optional(),
  title: z.string().trim().max(80).optional(),
  phone: z.string().trim().max(30).optional(),
})

export async function saveIdentityAction(_prev: ProfileState, formData: FormData): Promise<ProfileState> {
  const user = await requireUser()
  const parsed = identitySchema.safeParse({
    name: formData.get('name'),
    nickname: formData.get('nickname') || undefined,
    title: formData.get('title') || undefined,
    phone: formData.get('phone') || undefined,
  })
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  await db.user.update({
    where: { id: user.id },
    data: {
      name: parsed.data.name,
      nickname: parsed.data.nickname ?? null,
      title: parsed.data.title ?? null,
      phone: parsed.data.phone ?? null,
    },
  })
  await recordAudit(user, { action: 'profile.updated', entityType: 'User', entityId: user.id, summary: 'Updated identity' })
  revalidatePath('/settings/profile')
  return { ok: 'Saved.' }
}

const ALIAS_RE = /^[a-z0-9]([a-z0-9._-]{0,30}[a-z0-9])?$/

const forwardingSchema = z.object({
  emailAlias: z
    .string()
    .trim()
    .toLowerCase()
    .regex(ALIAS_RE, 'Use letters, numbers, dots or dashes — like "hector" or "h.camarena".'),
  forwardingEmail: z.email('Enter the inbox to forward to.'),
})

export async function saveForwardingAction(_prev: ProfileState, formData: FormData): Promise<ProfileState> {
  const user = await requireUser()
  const parsed = forwardingSchema.safeParse({
    emailAlias: formData.get('emailAlias'),
    forwardingEmail: formData.get('forwardingEmail'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  const previous = await db.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { emailAlias: true },
  })

  try {
    await db.user.update({
      where: { id: user.id },
      data: {
        emailAlias: parsed.data.emailAlias,
        forwardingEmail: parsed.data.forwardingEmail.toLowerCase(),
        forwardingStatus: 'pending',
      },
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return { error: 'That address is already taken by a teammate — pick another.' }
    }
    throw e
  }

  let status: string = 'pending'
  if (emailRoutingConfigured()) {
    if (previous.emailAlias && previous.emailAlias !== parsed.data.emailAlias) {
      await removeForwardingRule(previous.emailAlias).catch(() => {})
    }
    try {
      status = await syncForwarding(user.id)
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Cloudflare rejected the change.' }
    }
  }

  await recordAudit(user, {
    action: 'profile.forwarding_updated',
    entityType: 'User',
    entityId: user.id,
    summary: `Forwarding ${parsed.data.emailAlias}@ → ${parsed.data.forwardingEmail}`,
  })
  revalidatePath('/settings/profile')
  return {
    ok:
      status === 'active'
        ? 'Your address is live.'
        : 'Saved — check that inbox for a verification email from Cloudflare, then come back and press "Check status".',
  }
}

/** Re-checks Cloudflare: if the destination got verified, the rule goes live. */
export async function checkForwardingAction(): Promise<ProfileState> {
  const user = await requireUser()
  if (!emailRoutingConfigured()) return { error: 'Email routing is not configured on this server yet.' }
  try {
    const status = await syncForwarding(user.id)
    revalidatePath('/settings/profile')
    return status === 'active'
      ? { ok: 'Verified — your address is live.' }
      : { error: 'Not verified yet. Open the Cloudflare email in your inbox and click its link first.' }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Could not reach Cloudflare.' }
  }
}

const signatureSchema = z.object({
  signatureStyle: z.enum(['formal', 'friendly']),
  signatureIncludePhone: z.coerce.boolean(),
})

export async function saveSignatureAction(_prev: ProfileState, formData: FormData): Promise<ProfileState> {
  const user = await requireUser()
  const parsed = signatureSchema.safeParse({
    signatureStyle: formData.get('signatureStyle'),
    signatureIncludePhone: formData.get('signatureIncludePhone') === 'on',
  })
  if (!parsed.success) return { error: 'Pick a signature style.' }

  await db.user.update({ where: { id: user.id }, data: parsed.data })
  await recordAudit(user, { action: 'profile.signature_updated', entityType: 'User', entityId: user.id })
  revalidatePath('/settings/profile')
  return { ok: 'Signature saved — every email you send now uses it.' }
}

/* ── Password & sign-in ───────────────────────────────────── */

export type PasswordState = { error?: string; ok?: string; fieldErrors?: Record<string, string> }

// Matches the dummy-hash equalizer in src/lib/auth.ts and the step-up action:
// when the user row vanished mid-session the compare still runs, so a wrong
// current password and a dead account take the same amount of time.
const DUMMY_HASH = '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu'

const CHANGE_BURST_WINDOW_MS = 5 * 60 * 1000
const CHANGE_BURST_MAX = 5

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password.'),
    newPassword: z.string().min(1, 'Choose a new password.'),
    confirm: z.string(),
  })
  .refine((d) => d.newPassword === d.confirm, {
    message: 'Passwords do not match.',
    path: ['confirm'],
  })

/**
 * Change password with the current one as proof. A server action is a public
 * POST endpoint, so it re-checks the session itself, rate-limits by counting
 * its own denial audit rows (the step-up idiom — a refused attempt writes one
 * too, so hammering extends the lockout), verifies the current password
 * against a FRESH hash with the dummy-hash equalizer, and applies the same
 * policy as the reset flow. Success voids every outstanding auth token of
 * both kinds: old reset emails and pending sign-in links must not survive a
 * credential change.
 */
export async function changePasswordAction(_prev: PasswordState, formData: FormData): Promise<PasswordState> {
  const user = await requireUser()

  const parsed = changePasswordSchema.safeParse({
    currentPassword: formData.get('currentPassword'),
    newPassword: formData.get('newPassword'),
    confirm: formData.get('confirm'),
  })
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] = issue.message
    return { fieldErrors }
  }

  const policy = passwordPolicyError(parsed.data.newPassword, user.email)
  if (policy) return { fieldErrors: { newPassword: policy } }

  const recentDenials = await db.auditEvent.count({
    where: {
      organizationId: user.organizationId,
      actorId: user.id,
      action: 'auth.password_change_denied',
      createdAt: { gte: new Date(Date.now() - CHANGE_BURST_WINDOW_MS) },
    },
  })
  if (recentDenials >= CHANGE_BURST_MAX) {
    await recordAudit(user, {
      action: 'auth.password_change_denied',
      entityType: 'User',
      entityId: user.id,
      summary: 'Password change rate limited',
      after: { reason: 'rate_limited' },
    })
    return { error: 'Too many failed attempts. Wait a few minutes and try again.' }
  }

  // The hash is fetched fresh — never trusted from the session — so a change
  // made in another tab or a deactivation takes effect immediately.
  const record = await db.user.findFirst({
    where: { id: user.id, isActive: true, deletedAt: null },
    select: { passwordHash: true },
  })
  const ok = await bcrypt.compare(parsed.data.currentPassword, record?.passwordHash ?? DUMMY_HASH)
  if (!record || !ok) {
    await recordAudit(user, {
      action: 'auth.password_change_denied',
      entityType: 'User',
      entityId: user.id,
      summary: 'Password change denied — current password check failed',
      after: { reason: 'bad_password' },
    })
    return { fieldErrors: { currentPassword: 'That password is not correct.' } }
  }

  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 10)
  await db.user.update({ where: { id: user.id }, data: { passwordHash } })
  await invalidateAllAuthTokens(user.id)

  // Audits carry no credential material — the action name is the whole story.
  await recordAudit(user, {
    action: 'auth.password_changed',
    entityType: 'User',
    entityId: user.id,
    summary: 'Password changed (current password verified)',
  })

  return { ok: 'Password changed. Your other sign-in links are now void.' }
}

export type ResetLinkState = { error?: string; ok?: string; devLink?: string }

/**
 * "Don't know your current password?" — mails a reset link to the SIGNED-IN
 * account's own email. Unlike the public forgot-password action there is no
 * enumeration theater (the caller is authenticated and learns nothing about
 * other accounts), but the issue caps are the same AuthToken-row burst limits,
 * so this path cannot be used to flood an inbox. The 'auth.reset_requested'
 * audit is written HERE — issueAuthToken itself never audits — one row per
 * issued link, same as the public path.
 */
export async function sendResetLinkAction(): Promise<ResetLinkState> {
  const user = await requireUser()

  let ipHash: string | null = null
  let origin: string | undefined
  try {
    const h = await headers()
    const forwarded = h.get('x-forwarded-for')?.split(',')[0]?.trim()
    if (forwarded) ipHash = hashValue(forwarded)
    const host = h.get('x-forwarded-host') ?? h.get('host')
    if (host) origin = `${h.get('x-forwarded-proto') ?? 'http'}://${host}`
  } catch {
    // Outside a request context — the link base falls back to env.
  }

  const since = new Date(Date.now() - AUTH_BURST_WINDOW_MS)
  const [byUser, byIp] = await Promise.all([
    db.authToken.count({ where: { userId: user.id, kind: 'PASSWORD_RESET', createdAt: { gte: since } } }),
    ipHash
      ? db.authToken.count({ where: { requestedIpHash: ipHash, createdAt: { gte: since } } })
      : Promise.resolve(0),
  ])
  if (!burstAllowsIssue({ byUser, byIp })) {
    return { error: 'A reset link was already sent recently — check your inbox (and spam) first.' }
  }

  const { token } = await issueAuthToken(user.id, 'PASSWORD_RESET', { requestedIpHash: ipHash })

  await recordAudit(user, {
    action: 'auth.reset_requested',
    entityType: 'User',
    entityId: user.id,
    summary: `Password reset link requested from profile for ${maskEmail(user.email)}`,
  })

  const mail = await sendPasswordResetEmail({ to: user.email, token, originFallback: origin })
  if (!mail.sent && mail.error) {
    return { error: `The email could not be sent: ${mail.error}` }
  }

  return {
    ok: `Reset link sent to ${maskEmail(user.email)}. It works once and expires in 30 minutes.`,
    ...(mail.devLink ? { devLink: mail.devLink } : {}),
  }
}
