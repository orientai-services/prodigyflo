'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { after } from 'next/server'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { db } from '@/lib/db'
import { hashValue, maskEmail } from '@/lib/crypto'
import {
  AUTH_BURST_WINDOW_MS,
  burstAllowsIssue,
  consumeAuthToken,
  invalidateAllAuthTokens,
  issueAuthToken,
  PASSWORD_MIN_LENGTH,
  passwordPolicyError,
  type AuthTokenKind,
} from '@/lib/auth-tokens'
import { sendMagicLinkEmail, sendPasswordResetEmail } from '@/lib/auth-mail'

/**
 * Self-service auth actions. These are PUBLIC POST endpoints by design — the
 * whole point is that the caller has no session — so the defenses here are
 * different from the usual first-line permission gate:
 *
 *  - No enumeration: the request actions return the exact same success shape
 *    whether or not the email has an account, including on the rate-limited
 *    path. Only a malformed email ever earns an error.
 *  - Burst limits ride the AuthToken rows themselves (the stepup.ts
 *    count-recent-rows idiom): max 3 issues per account per 15 minutes,
 *    max 8 per requesting IP hash across both flows.
 *  - Audits fire only when a real account was touched, carry the masked email
 *    only, and attribute to the affected user (the invite-acceptance idiom —
 *    there is no SessionUser to hand recordAudit).
 */

const emailSchema = z.object({ email: z.string().email('Enter a valid email address.') })

export type AuthRequestState = {
  ok?: boolean
  error?: string
  /** Mock-mail convenience — only ever set outside production. */
  devLink?: string
}

async function requestContext() {
  try {
    const h = await headers()
    const forwarded = h.get('x-forwarded-for')?.split(',')[0]?.trim()
    const host = h.get('x-forwarded-host') ?? h.get('host')
    const proto = h.get('x-forwarded-proto') ?? 'http'
    return {
      ipHash: forwarded ? hashValue(forwarded) : null,
      origin: host ? `${proto}://${host}` : undefined,
      userAgent: h.get('user-agent')?.slice(0, 400) ?? null,
    }
  } catch {
    return { ipHash: null, origin: undefined, userAgent: null }
  }
}

/** Direct AuditEvent insert for flows with no SessionUser (see invites.ts). */
async function recordSelfServiceAudit(
  user: { id: string; organizationId: string; name: string },
  input: { action: string; summary: string; ipHash: string | null; userAgent: string | null },
) {
  await db.auditEvent.create({
    data: {
      organizationId: user.organizationId,
      actorId: user.id,
      actorLabel: `${user.name} (self-service)`,
      action: input.action,
      entityType: 'User',
      entityId: user.id,
      summary: input.summary,
      ipHash: input.ipHash,
      userAgent: input.userAgent,
    },
  })
}

/**
 * Burst-check → mint → audit → mail, for one found account. Returns the mail
 * result, or null when the rate limiter refused (caller still says "ok").
 */
async function issueAndDeliver(
  kind: AuthTokenKind,
  user: { id: string; organizationId: string; name: string; email: string },
  ctx: { ipHash: string | null; origin?: string; userAgent: string | null },
) {
  const since = new Date(Date.now() - AUTH_BURST_WINDOW_MS)
  const [byUser, byIp] = await Promise.all([
    db.authToken.count({ where: { userId: user.id, kind, createdAt: { gte: since } } }),
    ctx.ipHash
      ? db.authToken.count({ where: { requestedIpHash: ctx.ipHash, createdAt: { gte: since } } })
      : Promise.resolve(0),
  ])

  if (!burstAllowsIssue({ byUser, byIp })) return null

  const { token } = await issueAuthToken(user.id, kind, { requestedIpHash: ctx.ipHash })

  await recordSelfServiceAudit(user, {
    action: kind === 'PASSWORD_RESET' ? 'auth.reset_requested' : 'auth.magic_requested',
    summary:
      kind === 'PASSWORD_RESET'
        ? `Password reset link requested for ${maskEmail(user.email)}`
        : `Magic sign-in link requested for ${maskEmail(user.email)}`,
    ipHash: ctx.ipHash,
    userAgent: ctx.userAgent,
  })

  return kind === 'PASSWORD_RESET'
    ? sendPasswordResetEmail({ to: user.email, token, originFallback: ctx.origin })
    : sendMagicLinkEmail({ to: user.email, token, originFallback: ctx.origin })
}

/** Shared engine for both "email me a link" actions. Always returns ok. */
async function requestAuthLink(kind: AuthTokenKind, formData: FormData): Promise<AuthRequestState> {
  const parsed = emailSchema.safeParse({ email: formData.get('email') })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Enter a valid email address.' }
  }

  const email = parsed.data.email.toLowerCase().trim()
  const { ipHash, origin, userAgent } = await requestContext()

  // Same lookup discipline as authorize() in src/lib/auth.ts: email is
  // globally unique by policy; orderBy is the determinism backstop.
  const user = await db.user.findFirst({
    where: { email, isActive: true, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, organizationId: true, name: true, email: true },
  })

  // Timing hygiene: in production, ALL found-account work — burst counts,
  // token mint, audit row, mail delivery — is deferred past the response
  // flush (next/server `after`), so an existing account answers in exactly
  // the time a missing or deactivated one does and neither the body nor the
  // clock is an enumeration oracle. Outside production the work runs inline
  // so the mock-mail devLink can ride back to the form.
  if (process.env.NODE_ENV === 'production') {
    if (user) {
      after(async () => {
        try {
          await issueAndDeliver(kind, user, { ipHash, origin, userAgent })
        } catch (err) {
          console.error('[auth] deferred link delivery failed:', err)
        }
      })
    }
    return { ok: true }
  }

  if (user) {
    const mail = await issueAndDeliver(kind, user, { ipHash, origin, userAgent })
    if (mail?.devLink) return { ok: true, devLink: mail.devLink }
  }

  return { ok: true }
}

export async function requestPasswordResetAction(
  _prev: AuthRequestState,
  formData: FormData,
): Promise<AuthRequestState> {
  return requestAuthLink('PASSWORD_RESET', formData)
}

export async function requestMagicLinkAction(
  _prev: AuthRequestState,
  formData: FormData,
): Promise<AuthRequestState> {
  return requestAuthLink('MAGIC_LINK', formData)
}

// ── reset completion ─────────────────────────────────────────────────────────

export type ResetPasswordState = { error?: string; fieldErrors?: Record<string, string> }

const resetSchema = z
  .object({
    token: z.string().min(20, 'This reset link is incomplete — open it again from your email.'),
    password: z.string().min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`),
    confirm: z.string(),
  })
  .refine((d) => d.password === d.confirm, {
    message: 'Passwords do not match.',
    path: ['confirm'],
  })

const LINK_DEAD = 'This reset link is invalid, expired, or already used. Request a new one below.'

export async function resetPasswordAction(
  _prev: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const parsed = resetSchema.safeParse({
    token: formData.get('token'),
    password: formData.get('password'),
    confirm: formData.get('confirm'),
  })
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] = issue.message
    return fieldErrors.token ? { error: fieldErrors.token } : { fieldErrors }
  }

  // Peek (without burning the token) for the email the policy check needs, so
  // a rejected password leaves the link alive for another try. The atomic
  // claim below remains the single source of truth for validity.
  const peek = await db.authToken.findFirst({
    where: {
      tokenHash: hashValue(parsed.data.token),
      kind: 'PASSWORD_RESET',
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { user: { select: { email: true } } },
  })
  if (!peek) return { error: LINK_DEAD }

  const policy = passwordPolicyError(parsed.data.password, peek.user.email)
  if (policy) return { fieldErrors: { password: policy } }

  // The claim IS the validation — concurrent submits of one link race on this
  // updateMany and exactly one wins.
  const user = await consumeAuthToken(parsed.data.token, 'PASSWORD_RESET')
  if (!user) return { error: LINK_DEAD }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10)
  await db.user.update({ where: { id: user.id }, data: { passwordHash } })

  // A credential change voids every outstanding link of BOTH kinds — an old
  // reset email or a pending sign-in link must not survive it.
  await invalidateAllAuthTokens(user.id)

  const { ipHash, userAgent } = await requestContext()
  await recordSelfServiceAudit(user, {
    action: 'auth.password_reset',
    summary: `Password reset completed for ${maskEmail(user.email)}`,
    ipHash,
    userAgent,
  })

  // Deliberately no auto-login: the reset proves inbox control, the sign-in
  // that follows proves the new password works.
  redirect('/login?reset=1')
}
