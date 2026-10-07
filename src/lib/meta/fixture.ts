/**
 * Preview-only Meta lead fixture mode.
 *
 * On a preview deployment we need to prove the webhook → Graph read → contact
 * path WITHOUT calling Meta. With META_FIXTURE_LEADS=true the webhook reads the
 * lead from a Graph-shaped `fixture_lead` object inside the (still HMAC-signed)
 * webhook change instead of calling graph.facebook.com. The same parser the real
 * Graph adapter uses turns it into a lead, so the fixture exercises the real
 * attribution code.
 *
 * It can never run in production: Vercel's production environment, the
 * production hostnames, and NODE_ENV=production outside a Vercel preview all
 * force it off, whatever META_FIXTURE_LEADS says.
 */
import { leadFromGraphResponse, type GraphLeadResponse } from './attribution'

const PROD_HOSTS = new Set(['prodigyflo.ai', 'www.prodigyflo.ai'])

function host(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

export function metaFixtureModeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.META_FIXTURE_LEADS !== 'true') return false
  if (env.VERCEL_ENV === 'production') return false
  for (const key of ['APP_URL', 'AUTH_URL']) {
    const h = host(env[key])
    if (h && PROD_HOSTS.has(h)) return false
  }
  if (env.VERCEL_ENV === 'preview') return true
  // Local dev and the test runner only.
  return env.NODE_ENV === 'test' || env.NODE_ENV === 'development'
}

/** Read the mocked Graph response carried in a fixture webhook change. */
export function fixtureLeadFrom(value: Record<string, unknown>, leadgenId: string) {
  const raw = value.fixture_lead as GraphLeadResponse | undefined
  if (!raw || typeof raw !== 'object') throw new Error('Fixture mode: change has no fixture_lead.')
  if (raw.id !== leadgenId) throw new Error('Fixture mode: fixture_lead.id must equal leadgen_id.')
  return leadFromGraphResponse(raw)
}
