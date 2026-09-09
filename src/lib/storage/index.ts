import 'server-only'
import type { FileStorage } from './types'
import { LocalFileStorage } from './local'
import { S3FileStorage } from './s3'

let cached: FileStorage | null = null

/** Driver selection lives here and nowhere else. Production must be `s3` / `spaces`. */
export function getFileStorage(): FileStorage {
  if (cached) return cached
  const driver = (process.env.FILE_STORAGE_DRIVER || 'local').toLowerCase()
  if (driver === 'local') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FILE_STORAGE_DRIVER=local is not allowed in production. Use s3 or spaces.')
    }
    cached = new LocalFileStorage()
    return cached
  }
  if (driver === 's3' || driver === 'spaces') {
    cached = new S3FileStorage()
    return cached
  }
  throw new Error(`Unknown FILE_STORAGE_DRIVER "${driver}" — use "local" (dev) or "s3"/"spaces" (prod).`)
}

export const SIGNED_URL_TTL_SECONDS = Math.max(60, Number(process.env.FILE_SIGNED_URL_TTL ?? 300) || 300)

/**
 * Signed, short-lived URL for one document's file, for inline preview or
 * download. The route re-checks session + permission + client scope on top of
 * the signature.
 */
export async function signedDocumentFileUrl(
  doc: { id: string; storageKey: string | null },
  opts: { download?: boolean } = {},
): Promise<string | null> {
  if (!doc.storageKey) return null

  // A key the driver refuses (wrong shape, wrong driver, legacy demo row) means
  // there is no retrievable file — the same outcome as no key at all. Callers
  // already handle null; letting this throw would take down the whole page.
  let token: string
  try {
    token = await getFileStorage().signUrl(doc.storageKey, SIGNED_URL_TTL_SECONDS)
  } catch {
    return null
  }
  const qs = new URLSearchParams({ t: token })
  if (opts.download) qs.set('download', '1')
  return `/api/documents/${doc.id}/file?${qs}`
}

export type { FileStorage, PutMeta } from './types'
