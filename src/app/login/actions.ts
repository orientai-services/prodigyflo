'use server'

import { AuthError } from 'next-auth'
import { z } from 'zod'
import { signIn } from '@/lib/auth'
import { db } from '@/lib/db'
import { homeFor } from '@/lib/permissions'

const schema = z.object({
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
})

export type LoginState = { error?: string; fieldErrors?: Record<string, string> }

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = schema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  })

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      fieldErrors[String(issue.path[0])] = issue.message
    }
    return { fieldErrors }
  }

  const next = formData.get('next')
  let redirectTo = typeof next === 'string' && next.startsWith('/') ? next : null

  if (!redirectTo) {
    // Land each role on the home that suits it. Email uniqueness is global
    // (src/lib/invites.ts), so this matches at most one live user; orderBy is
    // a determinism backstop keeping this lookup and authorize() in
    // src/lib/auth.ts agreed on the same row if duplicates ever existed.
    const user = await db.user.findFirst({
      where: { email: parsed.data.email.toLowerCase().trim(), deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { role: { select: { key: true } }, landingPath: true },
    })
    redirectTo = user ? homeFor({ role: user.role.key, landingPath: user.landingPath }) : '/dashboard'
  }

  try {
    await signIn('credentials', { ...parsed.data, redirectTo })
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: 'That email and password combination is not recognized.' }
    }
    // signIn signals a successful redirect by throwing — let it through.
    throw error
  }

  return {}
}
