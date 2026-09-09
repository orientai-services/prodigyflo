/**
 * S3-compatible env for Spaces, AWS, or Supabase Storage.
 * FILE_STORAGE_* wins; DO_SPACES_* remains a fallback.
 */

export type ObjectStorageEnv = {
  endpoint: string | undefined
  region: string
  bucket: string | undefined
  accessKeyId: string
  secretAccessKey: string
}

export function objectStorageEnv(): ObjectStorageEnv {
  return {
    endpoint: process.env.FILE_STORAGE_ENDPOINT || process.env.DO_SPACES_ENDPOINT || undefined,
    region: process.env.FILE_STORAGE_REGION || process.env.DO_SPACES_REGION || 'us-east-1',
    bucket: process.env.FILE_STORAGE_BUCKET || process.env.DO_SPACES_BUCKET || undefined,
    accessKeyId: process.env.FILE_STORAGE_ACCESS_KEY || process.env.DO_SPACES_KEY || '',
    secretAccessKey: process.env.FILE_STORAGE_SECRET_KEY || process.env.DO_SPACES_SECRET || '',
  }
}

export function isSupabaseStorageEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return false
  return /supabase\.(co|com|in)/i.test(endpoint)
}

/** Supabase's S3 API is path-style. Spaces/AWS default to virtual-hosted. */
export function s3ForcePathStyle(endpoint = objectStorageEnv().endpoint): boolean {
  const raw = (process.env.FILE_STORAGE_FORCE_PATH_STYLE ?? '').toLowerCase()
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  return isSupabaseStorageEndpoint(endpoint)
}

/**
 * Canned ACL. Supabase Storage rejects these; Spaces and AWS accept `private`.
 * Set FILE_STORAGE_ACL=private|public-read to force, or empty to omit.
 */
export function s3ObjectAcl(): 'private' | 'public-read' | undefined {
  const raw = process.env.FILE_STORAGE_ACL
  if (raw === '') return undefined
  if (raw === 'private' || raw === 'public-read') return raw
  if (raw) return undefined
  if (isSupabaseStorageEndpoint(objectStorageEnv().endpoint)) return undefined
  return 'private'
}

export function s3PutExtra(): { ACL: 'private' | 'public-read' } | Record<string, never> {
  const acl = s3ObjectAcl()
  return acl ? { ACL: acl } : {}
}
