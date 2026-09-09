/**
 * Postgres connection knobs shared by the Prisma adapter and CLI scripts.
 */

export function isLocalDatabaseUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return /localhost|127\.0\.0\.1/i.test(url)
  }
}

export function databaseHostKind(url: string): string {
  if (isLocalDatabaseUrl(url)) return 'local'
  if (url.includes('ondigitalocean.com')) return 'DigitalOcean Managed Postgres'
  if (/supabase\.(co|com|in)/i.test(url)) return 'Supabase Postgres'
  return 'remote Postgres'
}

/**
 * TLS for any remote host. Local stays clear-text.
 * DO Managed Postgres presents a custom CA so we skip verification there only.
 * Supabase (and everyone else) uses a public CA — verify it.
 */
export function pgSsl(connectionString: string): { rejectUnauthorized: boolean } | undefined {
  if (isLocalDatabaseUrl(connectionString)) return undefined
  if (/[?&]sslmode=disable\b/i.test(connectionString)) return undefined
  if (connectionString.includes('ondigitalocean.com')) {
    return { rejectUnauthorized: false }
  }
  return { rejectUnauthorized: true }
}

/** Vercel isolates should hold one client. Override with PG_POOL_MAX. */
export function pgPoolMax(): number {
  const raw = process.env.PG_POOL_MAX
  if (raw !== undefined && raw !== '') {
    const n = Number(raw)
    if (Number.isFinite(n)) return Math.max(1, Math.floor(n))
  }
  if (process.env.VERCEL) return 1
  return 10
}
