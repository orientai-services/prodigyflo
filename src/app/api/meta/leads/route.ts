import { createHmac, timingSafeEqual } from 'node:crypto'
import { after } from 'next/server'
import { metaVerifyToken } from '@/lib/meta'
import { GraphMetaAdsProvider } from '@/lib/meta/graph'
import { resolveSigningContext } from '@/lib/meta/webhook-context'
import { igniteLead } from '@/lib/meta/ignition'
import { recordMetaWebhookLead } from '@/lib/call-center/meta-ingest'
import { callCenterMetaRoute } from '@/lib/call-center/meta-route'
import { fixtureLeadFrom, metaFixtureModeEnabled } from '@/lib/meta/fixture'
import type { MetaLead } from '@/lib/meta/provider'

/**
 * Meta Lead Ads webhook.
 *
 * GET  — Meta's subscription handshake: echo hub.challenge when the verify token
 *        matches (derived from AUTH_SECRET, so there is no extra secret to
 *        manage). The token only ever gates an echo, so it leaks nothing.
 * POST — leadgen notifications, authenticated by X-Hub-Signature-256 (HMAC of
 *        the raw body with the org's Meta App Secret, resolved from the
 *        credential vault, env fallback).
 *
 * Credentials resolve per-tenant through the connector vault, so an operator can
 * paste them into the Meta Ads connector card and go live with no redeploy.
 *
 * Security / correctness invariants:
 *  - The signing secret AND the Graph provider come from ONE credential snapshot,
 *    so a validly-signed real delivery is never served fabricated data by the mock
 *    provider (and the verify token is never accepted as an HMAC key — it is shown
 *    to every connectors:read user, so trusting it would allow forged leads).
 *  - Until an org is fully configured the endpoint returns 503 (retryable) rather
 *    than fabricating a lead; the in-app "send test lead" button exercises the
 *    pipeline in-process instead of through this public endpoint.
 *  - The request-independent signing context is memoised briefly so a flood of
 *    bogus signatures cannot force a DB query + vault decrypt per request.
 *  - Lead creation is synchronous (durable before the 200); a recoverable failure
 *    returns 503 so Meta redelivers, and the (source, leadgen id) idempotency key
 *    makes redelivery safe. Enrichment (Instant Lead Ignition) runs in after().
 *  - The SCS English Page (and its form) is written as a Call Center lead.
 *    That path does not create a Client and does not run ignition.
 *  - Every lead carries its source attribution (ad, ad set, campaign, form,
 *    platform, is_organic) and an out-of-area flag (state != NV).
 *  - Preview fixture mode (META_FIXTURE_LEADS=true, never in production — see
 *    src/lib/meta/fixture.ts) reads the lead from a signed, Graph-shaped
 *    `fixture_lead` instead of calling Meta. The signature check is unchanged.
 */

export async function GET(req: Request) {
  const url = new URL(req.url)
  if (
    url.searchParams.get('hub.mode') === 'subscribe' &&
    url.searchParams.get('hub.verify_token') === metaVerifyToken()
  ) {
    return new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 })
  }
  return new Response('Verification failed', { status: 403 })
}

function validSignature(raw: string, header: string | null, secret: string): boolean {
  if (!header?.startsWith('sha256=') || !secret) return false
  const expected = createHmac('sha256', secret).update(raw).digest('hex')
  const got = header.slice(7)
  return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected))
}

type LeadgenChange = {
  field: string
  value: {
    leadgen_id: string
    page_id?: string
    ad_id?: string
    adgroup_id?: string
    form_id?: string
    /** Preview fixture mode only: a mocked Graph lead response. Ignored otherwise. */
    fixture_lead?: unknown
  }
}
type WebhookBody = { object?: string; entry?: { id?: string; changes?: LeadgenChange[] }[] }

export async function POST(req: Request) {
  const raw = await req.text()
  const sig = req.headers.get('x-hub-signature-256')
  // Cheap reject before any DB/vault work: filters unsigned/malformed spam free.
  if (!sig?.startsWith('sha256=')) {
    return Response.json({ error: 'Invalid signature.' }, { status: 401 })
  }

  const ctx = await resolveSigningContext()
  if (!ctx) return Response.json({ error: 'No organization.' }, { status: 500 })

  // Fixture mode never reads Graph, so it needs only the signing secret.
  const fixture = metaFixtureModeEnabled()

  // Not fully configured → we cannot authenticate a real delivery and must not
  // fabricate one. 503 is retryable, so Meta redelivers once credentials land.
  if (fixture ? !ctx.secret : !ctx.live) {
    return Response.json({ error: 'Meta Ads not configured.' }, { status: 503 })
  }

  if (!validSignature(raw, sig, ctx.secret)) {
    return Response.json({ error: 'Invalid signature.' }, { status: 401 })
  }

  let body: WebhookBody
  try {
    body = JSON.parse(raw)
  } catch {
    return Response.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  // Provider built from the SAME snapshot that passed the gate — the live check
  // and the adapter can never disagree, so a real signed lead is never served
  // mock data.
  const provider = new GraphMetaAdsProvider(ctx.creds)
  const results: { leadgenId: string; duplicate: boolean; status: string; created: boolean }[] = []
  const ignitions: { clientId: string; leadgenId: string }[] = []
  let recoverableFailure = false

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'leadgen' || !change.value?.leadgen_id) continue
      const leadgenId = change.value.leadgen_id
      try {
        const lead: MetaLead = fixture
          ? fixtureLeadFrom(change.value as Record<string, unknown>, leadgenId)
          : await provider.fetchLead(leadgenId)
        const pageId = change.value.page_id ?? entry.id ?? null
        const formId = change.value.form_id ?? null
        const desk = callCenterMetaRoute({ pageId, formId }) === 'call-center'
        const recorded = await recordMetaWebhookLead({
          organizationId: ctx.orgId,
          lead,
          pageId,
          formId,
          adExternalId: change.value.ad_id,
          adSetExternalId: change.value.adgroup_id,
          fixture,
        })
        results.push({
          leadgenId: lead.leadgenId,
          duplicate: recorded.duplicate,
          status: recorded.status,
          created: recorded.createdClient,
        })
        if (!desk && recorded.createdClient && recorded.clientId) {
          ignitions.push({ clientId: recorded.clientId, leadgenId: lead.leadgenId })
        }
      } catch (err) {
        // The failure happened before any durable record. Returning 200 would let
        // Meta drop the lead forever; instead we 503 below so it redelivers, and
        // idempotency (leadgen id) makes the already-succeeded leads dedupe.
        console.error('[meta] lead ingest failed for', leadgenId, err)
        results.push({ leadgenId, duplicate: false, status: 'FAILED', created: false })
        recoverableFailure = true
      }
    }
  }

  // Instant Lead Ignition runs after the 200: enrichment must never slow the
  // webhook, and the leads above are already durably created.
  if (ignitions.length) {
    after(async () => {
      for (const ig of ignitions) {
        try {
          await igniteLead(ctx.orgId, ig.clientId, ig.leadgenId)
        } catch (err) {
          console.error('[meta] ignition failed for client', ig.clientId, err)
        }
      }
    })
  }

  if (recoverableFailure) {
    // Some leads did not reach a durable state — ask Meta to redeliver the batch.
    return Response.json({ received: results.length, results, retry: true }, { status: 503 })
  }
  return Response.json({ received: results.length, results })
}
