import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/rbac'
import { recordAudit } from '@/lib/audit'
import { getFileStorage } from '@/lib/storage'
import {
  avatarKeyFromUrl,
  avatarPublicPath,
  avatarStorageKey,
  validateAvatarUpload,
} from '@/lib/profile/avatar'

/**
 * Profile avatar upload/removal — always for the CALLER's own account, never
 * anyone else's, so the session IS the authorization. Acceptance is decided by
 * magic-byte sniffing (JPEG/PNG/WebP, 2 MB); storage is the deterministic
 * per-user key with overwrite semantics — a replace deletes the old object
 * when its extension differs and overwrites in place when it doesn't.
 */

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function POST(request: Request) {
  const user = await getSessionUser()
  if (!user) return json(401, { error: 'Unauthorized' })

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return json(400, { error: 'Expected multipart/form-data.' })
  }

  const file = form.get('file')
  if (!(file instanceof File)) return json(400, { error: 'Pick an image first.' })

  const buffer = Buffer.from(await file.arrayBuffer())
  const validation = validateAvatarUpload(buffer, file.type)
  if (!validation.ok) return json(422, { error: validation.reason })

  const storage = getFileStorage()
  const key = avatarStorageKey(user.id, validation.ext)

  // avatarUrl is read fresh — the cached session copy may predate a change in
  // another tab. The stale object is removed only when the extension (and so
  // the key) actually changed; a same-type replace is a plain overwrite.
  const current = await db.user.findUnique({ where: { id: user.id }, select: { avatarUrl: true } })
  const oldKey = avatarKeyFromUrl(current?.avatarUrl)

  await storage.putAt(key, buffer)
  if (oldKey && oldKey !== key) await storage.delete(oldKey).catch(() => {})

  const avatarUrl = avatarPublicPath(user.id, validation.ext, Date.now())
  await db.user.update({ where: { id: user.id }, data: { avatarUrl } })

  // Metadata only — never file contents.
  await recordAudit(user, {
    action: 'profile.avatar_updated',
    entityType: 'User',
    entityId: user.id,
    summary: `Updated profile photo (${validation.mimeType}, ${(buffer.length / 1024).toFixed(0)} KB)`,
    after: { mimeType: validation.mimeType, sizeBytes: buffer.length },
  })

  return json(200, { ok: true, avatarUrl })
}

export async function DELETE() {
  const user = await getSessionUser()
  if (!user) return json(401, { error: 'Unauthorized' })

  const current = await db.user.findUnique({ where: { id: user.id }, select: { avatarUrl: true } })
  const key = avatarKeyFromUrl(current?.avatarUrl)

  if (key) await getFileStorage().delete(key).catch(() => {})
  await db.user.update({ where: { id: user.id }, data: { avatarUrl: null } })

  await recordAudit(user, {
    action: 'profile.avatar_removed',
    entityType: 'User',
    entityId: user.id,
    summary: 'Removed profile photo',
  })

  return json(200, { ok: true })
}
