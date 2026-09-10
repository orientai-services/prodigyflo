import { afterEach, describe, expect, it } from 'vitest'
import { bearerMatches, bearerToken, cronAuthorized } from '@/lib/cron-auth'
import { isLocalDatabaseUrl, pgPoolMax, pgSsl } from '@/lib/pg-env'
import {
  isSupabaseStorageEndpoint,
  s3ForcePathStyle,
  s3ObjectAcl,
  objectStorageEnv,
} from '@/lib/storage/s3-config'

const saved: Record<string, string | undefined> = {}

function setEnv(key: string, value: string | undefined) {
  if (!(key in saved)) saved[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
    delete saved[key]
  }
})

describe('pg-env', () => {
  it('treats localhost as local and skips TLS', () => {
    expect(isLocalDatabaseUrl('postgresql://localhost:5432/prodigyflo')).toBe(true)
    expect(isLocalDatabaseUrl('postgresql://127.0.0.1:5432/scs')).toBe(true)
    expect(pgSsl('postgresql://localhost:5432/prodigyflo')).toBeUndefined()
  })

  it('enables verified TLS for Supabase and skips CA verify only for DigitalOcean', () => {
    const supabase =
      'postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require'
    expect(isLocalDatabaseUrl(supabase)).toBe(false)
    // Supabase's chain roots in its own private CA, so verification only
    // succeeds when that root is supplied; asserting rejectUnauthorized alone
    // passed the test while every real connection failed SELF_SIGNED_CERT_IN_CHAIN.
    expect(pgSsl(supabase)).toEqual({
      rejectUnauthorized: true,
      ca: expect.stringContaining('BEGIN CERTIFICATE'),
    })
    expect(pgSsl('postgresql://user:pw@db.example.ondigitalocean.com:25060/defaultdb')).toEqual({
      rejectUnauthorized: false,
    })
  })

  it('uses pool size 1 on Vercel unless PG_POOL_MAX is set', () => {
    setEnv('VERCEL', '1')
    setEnv('PG_POOL_MAX', undefined)
    expect(pgPoolMax()).toBe(1)
    setEnv('PG_POOL_MAX', '4')
    expect(pgPoolMax()).toBe(4)
  })
})

describe('s3-config', () => {
  it('prefers FILE_STORAGE_* over DO_SPACES_*', () => {
    setEnv('FILE_STORAGE_ENDPOINT', 'https://abc.storage.supabase.co/storage/v1/s3')
    setEnv('FILE_STORAGE_BUCKET', 'docs')
    setEnv('FILE_STORAGE_ACCESS_KEY', 'ak')
    setEnv('FILE_STORAGE_SECRET_KEY', 'sk')
    setEnv('DO_SPACES_ENDPOINT', 'https://nyc3.digitaloceanspaces.com')
    setEnv('DO_SPACES_BUCKET', 'spaces-bucket')
    const env = objectStorageEnv()
    expect(env.endpoint).toContain('supabase.co')
    expect(env.bucket).toBe('docs')
    expect(env.accessKeyId).toBe('ak')
  })

  it('turns on path-style and omits ACL for Supabase Storage', () => {
    setEnv('FILE_STORAGE_ENDPOINT', 'https://abc.storage.supabase.co/storage/v1/s3')
    setEnv('FILE_STORAGE_FORCE_PATH_STYLE', undefined)
    setEnv('FILE_STORAGE_ACL', undefined)
    expect(isSupabaseStorageEndpoint(objectStorageEnv().endpoint)).toBe(true)
    expect(s3ForcePathStyle()).toBe(true)
    expect(s3ObjectAcl()).toBeUndefined()
  })

  it('keeps virtual-hosted + private ACL for Spaces unless overridden', () => {
    setEnv('FILE_STORAGE_ENDPOINT', undefined)
    setEnv('DO_SPACES_ENDPOINT', 'https://nyc3.digitaloceanspaces.com')
    setEnv('FILE_STORAGE_FORCE_PATH_STYLE', undefined)
    setEnv('FILE_STORAGE_ACL', undefined)
    expect(s3ForcePathStyle()).toBe(false)
    expect(s3ObjectAcl()).toBe('private')
  })
})

describe('cron-auth', () => {
  it('accepts CRON_SECRET or an extra app secret', () => {
    setEnv('CRON_SECRET', 'vercel-cron')
    const req = { headers: { get: (name: string) => (name === 'authorization' ? 'Bearer vercel-cron' : null) } }
    expect(cronAuthorized(req, ['jobs-token'])).toBe(true)
    const req2 = { headers: { get: (name: string) => (name === 'authorization' ? 'Bearer jobs-token' : null) } }
    expect(cronAuthorized(req2, ['jobs-token'])).toBe(true)
    const req3 = { headers: { get: (name: string) => (name === 'authorization' ? 'Bearer nope' : null) } }
    expect(cronAuthorized(req3, ['jobs-token'])).toBe(false)
  })

  it('refuses an empty bearer', () => {
    expect(bearerToken({ headers: { get: () => null } })).toBe('')
    expect(bearerMatches('', ['secret'])).toBe(false)
    expect(bearerMatches('secret', [undefined])).toBe(false)
  })
})
