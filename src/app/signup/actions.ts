'use server'

import bcrypt from 'bcryptjs'
import { Prisma, RoleKey } from '@prisma/client'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { passwordPolicyError } from '@/lib/auth-tokens'
import { db } from '@/lib/db'

const signupSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name.').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  password: z.string().min(1, 'Choose a password.'),
  passwordConfirmation: z.string().min(1, 'Confirm your password.'),
  // A visually-hidden bot trap. The production flag remains the security boundary.
  website: z.string().max(0).optional(),
})

export type SignupState = { error?: string; fieldErrors?: Record<string, string> }

function uniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

// Public registration is for the ProdigyFlo team, not tenant provisioning.
// A deployment may override this only when it intentionally has a different
// shared workspace. Do not accept a workspace identifier from the browser.
const DEFAULT_PUBLIC_SIGNUP_WORKSPACE_SLUG = 'prodigyflo'
const PUBLIC_SIGNUP_ROLE = RoleKey.CLOSER

/**
 * Public signup joins a new staff member to the configured shared workspace.
 * Elevated roles and cross-workspace access remain invite/admin-only actions.
 */
export async function signupAction(_prev: SignupState, formData: FormData): Promise<SignupState> {
  if (process.env.ALLOW_SELF_SIGNUP !== 'true') {
    return { error: 'Self-service signup is not enabled for this site.' }
  }

  const parsed = signupSchema.safeParse({
    name: formData.get('name'),
    email: formData.get('email'),
    password: formData.get('password'),
    passwordConfirmation: formData.get('passwordConfirmation'),
    website: formData.get('website') || undefined,
  })
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] = issue.message
    return { fieldErrors }
  }

  const input = parsed.data
  if (input.password !== input.passwordConfirmation) {
    return { fieldErrors: { passwordConfirmation: 'Passwords do not match.' } }
  }
  const passwordError = passwordPolicyError(input.password, input.email)
  if (passwordError) return { fieldErrors: { password: passwordError } }

  const existing = await db.user.findFirst({
    where: { email: input.email, deletedAt: null },
    select: { id: true },
  })
  if (existing) return { error: 'An account with that email already exists. Sign in instead.' }

  const passwordHash = await bcrypt.hash(input.password, 10)
  const workspaceSlug = process.env.PUBLIC_SIGNUP_ORGANIZATION_SLUG?.trim() || DEFAULT_PUBLIC_SIGNUP_WORKSPACE_SLUG
  const workspace = await db.organization.findUnique({
    where: { slug: workspaceSlug },
    select: {
      id: true,
      deletedAt: true,
      roles: { where: { key: PUBLIC_SIGNUP_ROLE }, select: { id: true } },
    },
  })
  const roleId = workspace?.roles[0]?.id
  if (!workspace || workspace.deletedAt || !roleId) {
    // Never silently create a workspace for a public request. That would
    // recreate the isolated-tenant behavior this flow deliberately removed.
    return { error: 'Registration is temporarily unavailable. Please contact your administrator.' }
  }

  try {
    const user = await db.user.create({
      data: {
        organizationId: workspace.id,
        roleId,
        name: input.name,
        email: input.email,
        passwordHash,
        isActive: true,
        isOwner: false,
      },
      select: { id: true },
    })

    await db.auditEvent.create({
      data: {
        organizationId: workspace.id,
        actorId: user.id,
        actorLabel: `${input.name} (Self-registered staff)`,
        action: 'account.self_signup',
        entityType: 'User',
        entityId: user.id,
        summary: `Joined shared workspace ${workspaceSlug} through self-service signup.`,
      },
    })
  } catch (error) {
    if (uniqueViolation(error)) {
      return { error: 'An account with that email already exists. Sign in instead.' }
    }
    throw error
  }

  // redirect() throws Next control flow, so it stays outside the write path.
  redirect('/login?created=1')
}
