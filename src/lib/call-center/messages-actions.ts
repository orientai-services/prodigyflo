'use server'

import { requireUser } from '@/lib/rbac'
import { cleanText, parseThreadKey } from './messages-core'
import { markThreadRead, sendThreadText, type SendTextResult } from './messages'

/**
 * Server actions behind the Messages section (docs/DIALER_APP.md §4). The
 * browser sends a thread key and the words, never a number; who the text goes
 * to, and whether it may go at all, is decided on the server.
 */

export async function sendMessagesText(threadKey: string, text: string): Promise<SendTextResult> {
  const user = await requireUser()
  const key = parseThreadKey(threadKey)
  if (!key) return { ok: false, error: "That conversation isn't in your list." }
  const clean = cleanText(text)
  if (!clean.ok) return clean
  return sendThreadText(user, key, clean.text)
}

export async function markMessagesRead(threadKey: string): Promise<{ ok: boolean; changed: number }> {
  const user = await requireUser()
  const key = parseThreadKey(threadKey)
  if (!key) return { ok: false, changed: 0 }
  return { ok: true, changed: await markThreadRead(user, key) }
}
