import { fundingTracksPayments } from './metrics'

/**
 * Payment detection (docs/META_ADS_SCS.md §3.4). Graph has no payments edge, so
 * a payment is inferred when the unpaid balance drops and stays down. Pure:
 * the sync feeds one accepted reading at a time and stores `pending`.
 *
 * Amounts are a floor (spend keeps accruing while Meta charges), and a row can
 * also be a manual payment, credit or refund, so every emitted row is labelled
 * "Payment or charge, about $X" and marked approximate.
 */

export type Reading = {
  snapshotId: string
  balanceCents: number
  amountSpentCents: number
  fundingType: number | null
  at: Date
}

export type Pending = {
  fromSnapshotId: string
  fromCents: number
  toCents: number
  fromSpentCents: number
  detectedAt: string
  confirmations: number
  readings: number
  lastAt: string
}

export type DetectorEvent = 'off' | 'stale' | 'none' | 'candidate' | 'confirming' | 'confirmed' | 'bounce' | 'deeper' | 'expired'

export type DetectorStep = {
  pending: Pending | null
  emit: { fromSnapshotId: string; amountCents: number; occurredAt: string } | null
  event: DetectorEvent
}

/** Minimum drop worth a candidate, and the slack used everywhere: $1. */
const SLACK = 100
const DROP_RATIO = 0.6
const BOUNCE_RATIO = 0.9
const NEEDED = 2
const MAX_READINGS = 12
const GAP_MS = 30 * 60_000

export function stepChargeDetector(prev: Reading | null, pending: Pending | null, r: Reading): DetectorStep {
  // 0. Funding: prepaid and Meta-balance accounts don't behave like a bill.
  if (!fundingTracksPayments(r.fundingType)) return { pending: null, emit: null, event: 'off' }

  // Re-running the reading already applied changes nothing.
  if (prev && prev.snapshotId === r.snapshotId) return { pending, emit: null, event: 'none' }
  if (pending && pending.fromSnapshotId === r.snapshotId) return { pending, emit: null, event: 'none' }

  // 1. Stale replica: amount_spent never goes backwards on a real account.
  if (prev && r.amountSpentCents < prev.amountSpentCents) return { pending, emit: null, event: 'stale' }

  const at = r.at.toISOString()

  // 2. No pending charge: look for a big enough drop.
  if (!pending) {
    if (prev && prev.balanceCents - r.balanceCents >= SLACK && r.balanceCents <= DROP_RATIO * prev.balanceCents) {
      return {
        pending: {
          fromSnapshotId: r.snapshotId,
          fromCents: prev.balanceCents,
          toCents: r.balanceCents,
          fromSpentCents: r.amountSpentCents,
          detectedAt: at,
          confirmations: 0,
          readings: 0,
          lastAt: at,
        },
        emit: null,
        event: 'candidate',
      }
    }
    return { pending: null, emit: null, event: 'none' }
  }

  // 3. A pending charge: confirm it, deepen it, or let it go.
  const spentSince = r.amountSpentCents - pending.fromSpentCents
  const next: Pending = { ...pending, readings: pending.readings + 1, lastAt: at }

  // Bounce: the balance came back without spend moving. It wasn't a payment.
  if (r.balanceCents >= BOUNCE_RATIO * pending.fromCents && spentSince <= SLACK) {
    return { pending: null, emit: null, event: 'bounce' }
  }

  let event: DetectorEvent = 'none'
  if (r.balanceCents < pending.toCents - SLACK) {
    next.toCents = r.balanceCents
    event = 'deeper'
  } else {
    const stillLow = r.balanceCents <= Math.max(pending.toCents + SLACK, DROP_RATIO * pending.fromCents)
    const explainedBySpend = r.balanceCents - pending.toCents <= spentSince + SLACK
    if (stillLow || explainedBySpend) {
      const gap = r.at.getTime() - new Date(pending.lastAt).getTime()
      next.confirmations += gap >= GAP_MS ? 2 : 1
      event = 'confirming'
    }
  }

  if (next.confirmations >= NEEDED) {
    return {
      pending: null,
      emit: { fromSnapshotId: next.fromSnapshotId, amountCents: next.fromCents - next.toCents, occurredAt: next.detectedAt },
      event: 'confirmed',
    }
  }
  if (next.readings >= MAX_READINGS) return { pending: null, emit: null, event: 'expired' }
  return { pending: next, emit: null, event }
}

/** Defensive parse of the JSON stored on MetaAdAccount.pendingCharge. */
export function parsePending(raw: unknown): Pending | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const p = raw as Record<string, unknown>
  const n = (k: string) => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? (p[k] as number) : null)
  const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : null)
  const fromSnapshotId = s('fromSnapshotId'), detectedAt = s('detectedAt'), lastAt = s('lastAt')
  const fromCents = n('fromCents'), toCents = n('toCents'), fromSpentCents = n('fromSpentCents')
  const confirmations = n('confirmations'), readings = n('readings')
  if (!fromSnapshotId || !detectedAt || !lastAt || fromCents === null || toCents === null || fromSpentCents === null || confirmations === null || readings === null) {
    return null
  }
  return { fromSnapshotId, fromCents, toCents, fromSpentCents, detectedAt, confirmations, readings, lastAt }
}

/** "Payment or charge, about $X" */
export function paymentLabel(amountCents: number): string {
  return `Payment or charge, about $${(amountCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
