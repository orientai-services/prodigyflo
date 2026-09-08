import { sniffMimeType, normalizeMime } from '@/lib/extraction/sniff'

/**
 * Profile avatar rules — pure module, unit-tested without a server context.
 *
 * Acceptance is decided by magic-byte sniffing (the documents-upload
 * discipline): the declared Content-Type is attacker-controlled and only has
 * to agree with what the bytes actually are. Avatars are narrower than
 * documents — raster images the browser can paint inline, nothing else.
 *
 * Storage uses a DETERMINISTIC per-user key (`avatars/<userId>.<ext>`), not
 * the random opaque keys documents get: one user has at most one avatar, a
 * replace overwrites in place, and the serving route can derive the key from
 * the URL without a lookup table.
 */

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024

/** Sniffed mime → storage/URL extension. The allow-list, in one place. */
export const AVATAR_MIME_TO_EXT: Record<string, 'jpg' | 'png' | 'webp'> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

export const AVATAR_EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

export type AvatarValidation =
  | { ok: true; mimeType: string; ext: 'jpg' | 'png' | 'webp' }
  | { ok: false; reason: string }

/** Magic-byte validation for an avatar upload. */
export function validateAvatarUpload(buffer: Buffer, declaredMime: string): AvatarValidation {
  if (buffer.length === 0) return { ok: false, reason: 'The file is empty.' }
  if (buffer.length > AVATAR_MAX_BYTES) {
    const mb = (buffer.length / 1024 / 1024).toFixed(1)
    return { ok: false, reason: `That image is ${mb} MB — the limit is 2 MB. Try a smaller crop.` }
  }

  const sniffed = sniffMimeType(buffer)
  const ext = sniffed ? AVATAR_MIME_TO_EXT[sniffed] : undefined
  if (!sniffed || !ext) {
    return { ok: false, reason: 'Use a JPEG, PNG, or WebP image.' }
  }

  // A declared type that disagrees with the bytes is a rename trick; an empty
  // declaration (some clients omit it) defers to the sniff.
  const declared = normalizeMime(declaredMime || sniffed)
  if (declared !== sniffed) {
    return {
      ok: false,
      reason: `The file's content (${sniffed}) does not match its declared type (${declared}).`,
    }
  }
  return { ok: true, mimeType: sniffed, ext }
}

/** cuid/cuid2-shaped ids only — the key is a path segment, so this is load-bearing. */
const USER_ID_RE = /^[a-z0-9]{10,40}$/

/** Deterministic storage key for one user's avatar. Throws on a hostile id. */
export function avatarStorageKey(userId: string, ext: string): string {
  if (!USER_ID_RE.test(userId)) throw new Error('Invalid user id for avatar key.')
  if (!(ext in AVATAR_EXT_TO_MIME)) throw new Error('Invalid avatar extension.')
  return `avatars/${userId}.${ext}`
}

/**
 * The app-served path stored on User.avatarUrl. The `v` query is a
 * cache-buster (the key is stable, the bytes are not), so every <img> and the
 * user menu pick up a replaced photo without a hard reload.
 */
export function avatarPublicPath(userId: string, ext: string, version: number): string {
  // Reuses the key validation — same charset rules apply to the URL segment.
  avatarStorageKey(userId, ext)
  return `/api/profile/avatar/${userId}.${ext}?v=${version}`
}

/**
 * Parses the `<userId>.<ext>` dynamic segment of the serving route.
 * Returns null for anything that is not exactly an id plus an allowed
 * extension — the route 404s rather than touching storage.
 */
export function parseAvatarFileParam(param: string): { userId: string; ext: string } | null {
  const dot = param.lastIndexOf('.')
  if (dot <= 0) return null
  const userId = param.slice(0, dot)
  const ext = param.slice(dot + 1).toLowerCase()
  if (!USER_ID_RE.test(userId) || !(ext in AVATAR_EXT_TO_MIME)) return null
  return { userId, ext }
}

/**
 * Derives the storage key back out of a stored avatarUrl
 * (`/api/profile/avatar/<userId>.<ext>?v=N`). Null when the URL is absent or
 * not one of ours — callers then simply have nothing to delete.
 */
export function avatarKeyFromUrl(avatarUrl: string | null | undefined): string | null {
  if (!avatarUrl) return null
  const match = /^\/api\/profile\/avatar\/([^/?#]+)/.exec(avatarUrl)
  if (!match) return null
  const parsed = parseAvatarFileParam(match[1])
  return parsed ? avatarStorageKey(parsed.userId, parsed.ext) : null
}
