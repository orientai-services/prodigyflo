'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { InviteError, acceptInvite } from '@/lib/invites'

const schema = z.object({
  email: z.email('Enter a valid email address.').optional(),
  name: z.string().trim().min(2, 'Enter your full name.').max(80),
  password: z.string().min(10, 'Use at least 10 characters.').max(200),
  confirm: z.string(),
})

export type AcceptState = { error?: string; fieldErrors?: Record<string, string> }

export async function acceptInviteAction(
  token: string,
  _prev: AcceptState,
  formData: FormData,
): Promise<AcceptState> {
  const parsed = schema.safeParse({
    email: formData.get('email') || undefined,
    name: formData.get('name'),
    password: formData.get('password'),
    confirm: formData.get('confirm'),
  })
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] = issue.message
    return { fieldErrors }
  }
  if (parsed.data.password !== parsed.data.confirm) {
    return { fieldErrors: { confirm: 'Passwords do not match.' } }
  }

  try {
    await acceptInvite(token, { name: parsed.data.name, password: parsed.data.password, email: parsed.data.email })
  } catch (e) {
    return { error: e instanceof InviteError ? e.message : 'Something went wrong — try the link again.' }
  }

  redirect('/login?joined=1')
}
