/**
 * File storage boundary. Uploaded client documents only ever move through this
 * interface — nothing else in the codebase touches the storage backend, and the
 * backing directory is never served statically. Downloads always go through
 * `GET /api/documents/[documentId]/file`, which re-checks permission and client
 * scope before streaming a byte.
 */

export type PutMeta = {
  fileName: string
  mimeType: string
  clientId: string
}

export interface FileStorage {
  readonly name: string
  /** Stores the buffer under a new random opaque key. */
  put(buf: Buffer, meta: PutMeta): Promise<{ key: string }>
  /**
   * Stores the buffer under a caller-chosen NAMESPACED key with overwrite
   * semantics (currently `avatars/<userId>.<ext>` only). Documents keep their
   * random opaque keys; this exists for the one-object-per-owner case where a
   * replace should overwrite in place and the key must be derivable.
   */
  putAt(key: string, buf: Buffer): Promise<void>
  /** File metadata for cache validation, or null when the object is absent. */
  stat(key: string): Promise<{ mtimeMs: number; size: number } | null>
  get(key: string): Promise<Buffer>
  /**
   * Returns a short-lived signed token authorizing exactly this stored object.
   * The token is placed on the download route's query string; the route still
   * re-checks session, permission, and client scope — the signature only makes
   * the URL single-purpose and expiring, it never replaces authorization.
   */
  signUrl(key: string, ttlSeconds: number): Promise<string>
  delete(key: string): Promise<void>
}
