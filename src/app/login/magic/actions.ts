'use server'

import { AuthError } from 'next-auth'
import { signIn } from '@/lib/auth'

export type MagicSignInState = { error?: string }

const DEAD_LINK =
  'This sign-in link is invalid, expired, or already used. Request a fresh one from the sign-in page.'

/**
 * Completes a magic-link sign-in. Rides the existing Credentials provider —
 * authorize() in src/lib/auth.ts recognises {magicToken} and consumes the
 * single-use token atomically — so session issuance, JWT shape and callbacks
 * are byte-identical to a password sign-in. Root ('/') then routes the fresh
 * session to its role home, exactly like any other landing.
 */
export async function completeMagicSignInAction(
  _prev: MagicSignInState,
  formData: FormData,
): Promise<MagicSignInState> {
  const token = formData.get('token')
  if (typeof token !== 'string' || token.length < 20) return { error: DEAD_LINK }

  try {
    await signIn('credentials', { magicToken: token, redirectTo: '/' })
  } catch (error) {
    if (error instanceof AuthError) return { error: DEAD_LINK }
    // signIn signals a successful redirect by throwing — let it through.
    throw error
  }
  return {}
}
