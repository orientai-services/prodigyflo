import 'server-only'
import { db } from '@/lib/db'
import { credentialsConfigured, metaCredentialsFor, type MetaCredentials } from './provider'

/**
 * Shared signing context for the Meta webhooks (Lead Ads + Instagram — same app,
 * app secret, and META_ADS connector).
 *
 * Resolving the tenant and decrypting the vault App Secret is request-independent,
 * so it is memoised for a short TTL. That keeps a flood of bogus-signature requests
 * to either public webhook from forcing a DB query + AES-GCM vault decrypt per
 * request, and pins the signature secret and the provider to ONE snapshot so they
 * can never disagree.
 */

export type SigningContext = { orgId: string; live: boolean; secret: string; creds: MetaCredentials }

let ctxCache: (SigningContext & { at: number }) | null = null
const CTX_TTL_MS = 60_000

/**
 * The organization that runs Meta — the owner of the oldest enabled META_LEAD_ADS
 * intake source (SCS in production), else the oldest org. Single-tenant assumption:
 * the first enabled source wins.
 */
async function resolveMetaOrg(): Promise<{ id: string } | null> {
  const source = await db.intakeSource.findFirst({
    where: { kind: 'META_LEAD_ADS', isEnabled: true, organization: { deletedAt: null } },
    orderBy: { createdAt: 'asc' },
    select: { organizationId: true },
  })
  if (source) return { id: source.organizationId }
  return db.organization.findFirst({
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
}

export async function resolveSigningContext(): Promise<SigningContext | null> {
  if (ctxCache && Date.now() - ctxCache.at < CTX_TTL_MS) return ctxCache
  const org = await resolveMetaOrg()
  if (!org) return null
  const creds = await metaCredentialsFor(org.id)
  ctxCache = {
    orgId: org.id,
    live: credentialsConfigured(creds),
    secret: creds.appSecret ?? '',
    creds,
    at: Date.now(),
  }
  return ctxCache
}
