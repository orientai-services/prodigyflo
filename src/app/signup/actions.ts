'use server'

import bcrypt from 'bcryptjs'
import { Prisma } from '@prisma/client'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { passwordPolicyError } from '@/lib/auth-tokens'
import { db } from '@/lib/db'
import { bootstrapOrganization } from '@/lib/org/bootstrap'

const signupSchema = z.object({
  organizationName: z.string().trim().min(2, 'Enter your organization name.').max(120),
  name: z.string().trim().min(2, 'Enter your full name.').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  password: z.string().min(1, 'Choose a password.'),
  passwordConfirmation: z.string().min(1, 'Confirm your password.'),
  // A visually-hidden bot trap. The production flag remains the security boundary.
  website: z.string().max(0).optional(),
})

export type SignupState = { error?: string; fieldErrors?: Record<string, string> }

function slugBase(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 42)
  return slug || 'workspace'
}

function uniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

/**
 * Public signup always provisions a new workspace and its owner. Established
 * workspaces add staff through the authenticated invite flow instead.
 */
export async function signupAction(_prev: SignupState, formData: FormData): Promise<SignupState> {
  if (process.env.ALLOW_SELF_SIGNUP !== 'true') {
    return { error: 'Self-service signup is not enabled for this site.' }
  }

  const parsed = signupSchema.safeParse({
    organizationName: formData.get('organizationName'),
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
  const base = slugBase(input.organizationName)

  for (let suffix = 0; suffix < 50; suffix += 1) {
    const slug = suffix === 0 ? base : `${base}-${suffix + 1}`
    let organization: { id: string } | null = null

    try {
      // Reserving the slug proves this request owns the new organization.
      organization = await db.organization.create({
        data: { name: input.organizationName, slug },
        select: { id: true },
      })
    } catch (error) {
      if (uniqueViolation(error)) continue
      throw error
    }

    try {
      const bootstrap = await bootstrapOrganization(db, { name: input.organizationName, slug })
      const roleId = bootstrap.roleIdByKey.get('SUPER_ADMIN')
      if (!roleId) throw new Error('The owner role was not created.')

      const user = await db.user.create({
        data: {
          organizationId: bootstrap.organizationId,
          roleId,
          name: input.name,
          email: input.email,
          passwordHash,
          isActive: true,
          isOwner: true,
        },
        select: { id: true },
      })

      await db.auditEvent.create({
        data: {
          organizationId: bootstrap.organizationId,
          actorId: user.id,
          actorLabel: `${input.name} (Owner)`,
          action: 'account.self_signup',
          entityType: 'Organization',
          entityId: bootstrap.organizationId,
          summary: 'Created organization through self-service signup.',
        },
      })
    } catch (error) {
      // The ID came from this request's reservation, so cleanup cannot touch a
      // pre-existing workspace. This also avoids ownerless orgs after an email race.
      await db.organization.delete({ where: { id: organization.id } }).catch(() => undefined)
      if (uniqueViolation(error)) {
        return { error: 'An account with that email already exists. Sign in instead.' }
      }
      throw error
    }

    // redirect() throws Next control flow; keep it outside cleanup above.
    redirect('/login?created=1')
  }

  return { error: 'Please choose a more distinctive organization name and try again.' }
}
