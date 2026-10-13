'use client'

import { useEffect, useState } from 'react'
import { loadLeadTrail } from '@/lib/call-center/actions'
import type { CallLead, TrailEvent } from '@/lib/call-center/model'

const keyOf = (event: TrailEvent) => JSON.stringify([event.kind, event.at, event.label, event.detail])

/**
 * The whole Comms trail of `lead` once it has been read: what the server sent
 * plus anything the desk added since (a note saved here, a fresh refresh). The
 * desk list carries trimmed trails (lib/call-center/trail-summary.ts), so a
 * lead marked `trailPartial` reads its full history once when it opens; until
 * then, and if that read fails, the panel shows the trail it has.
 */
export function mergeTrail(full: readonly TrailEvent[], current: readonly TrailEvent[]): TrailEvent[] {
  const known = new Map<string, number>()
  for (const event of full) known.set(keyOf(event), (known.get(keyOf(event)) ?? 0) + 1)
  const extra: TrailEvent[] = []
  for (const event of current) {
    const key = keyOf(event)
    const left = known.get(key) ?? 0
    if (left > 0) known.set(key, left - 1)
    else extra.push(event)
  }
  if (!extra.length) return [...full]
  // Same order the desk keeps when it adds an event (model.ts addEvent).
  return [...full, ...extra].sort((a, b) => a.at.localeCompare(b.at))
}

export function useFullTrail(lead: CallLead | null): TrailEvent[] {
  const [full, setFull] = useState<{ id: string; trail: TrailEvent[] } | null>(null)
  const partialId = lead?.trailPartial && lead.persisted ? lead.id : null

  useEffect(() => {
    if (!partialId) return
    let current = true
    loadLeadTrail(partialId).then(
      (trail) => {
        if (current && trail) setFull({ id: partialId, trail })
      },
      () => {
        // Offline or refused: the panel keeps the trimmed trail it already shows.
      },
    )
    return () => {
      current = false
    }
  }, [partialId])

  if (!lead) return []
  if (!lead.trailPartial || !full || full.id !== lead.id) return lead.trail
  return mergeTrail(full.trail, lead.trail)
}
