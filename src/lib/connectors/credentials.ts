import 'server-only'
import type { ConnectorKind } from '@prisma/client'
import { db } from '@/lib/db'
import { decryptSecret } from '@/lib/crypto'

/**
 * The decryption seam for outbound adapters (email, SMS, Meta Ads, payments):
 * the ONLY place vault ciphertext becomes plaintext. Server-only by import
 * guard — this module must never be imported from a client component, and its
 * output must never be placed in a *View/VM type, an audit payload, a
 * ConnectorLog row, or anything else that leaves the server process.
 *
 * Adapters call it as a seam-with-fallback:
 *
 *   const creds = await getConnectorCredentials(orgId, 'EMAIL')
 *   const apiKey = creds?.apiKey ?? process.env.RESEND_API_KEY
 */

/**
 * Decrypted credential map ({ fieldKey: plaintext }) for one org's connector,
 * or null when the org has no enabled connector of this kind or nothing stored.
 * Requires VAULT_KEY; a tampered row or wrong key throws (AES-256-GCM
 * authenticates), which is the correct failure mode — never silent garbage.
 */
export async function getConnectorCredentials(
  organizationId: string,
  kind: ConnectorKind,
): Promise<Record<string, string> | null> {
  const connector = await db.connector.findUnique({
    where: { organizationId_kind: { organizationId, kind } },
    select: {
      isEnabled: true,
      credentials: {
        select: { fieldKey: true, ciphertext: true, iv: true, authTag: true, keyVersion: true },
      },
    },
  })
  if (!connector || !connector.isEnabled || connector.credentials.length === 0) return null

  const out: Record<string, string> = {}
  for (const row of connector.credentials) {
    out[row.fieldKey] = decryptSecret({
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.authTag,
      keyVersion: row.keyVersion,
    })
  }
  return out
}
