import { describe, expect, it } from 'vitest'
import {
  briefAdoptionItem,
  closeRateItem,
  coldCloserItem,
  hygieneItem,
  leakageItem,
  overdueItem,
  qualifierItem,
  slaItem,
  sortAttentionItems,
  type AttentionItem,
} from '@/lib/attention'

describe('leakageItem', () => {
  const base = { leakingCount: 6, liveCount: 100, leakageDays: 7, targetPct: 5 }

  it('is null when there is no live-lead sample', () => {
    expect(leakageItem({ ...base, leakagePct: null, leakingCount: 0 })).toBeNull()
  })

  it('is null at or below the phase ceiling', () => {
    expect(leakageItem({ ...base, leakagePct: 5, leakingCount: 5 })).toBeNull()
    expect(leakageItem({ ...base, leakagePct: 4.9 })).toBeNull()
  })

  it('warns just over the ceiling and carries the count', () => {
    const item = leakageItem({ ...base, leakagePct: 6, leakingCount: 6 })
    expect(item?.severity).toBe('warning')
    expect(item?.count).toBe(6)
    expect(item?.detail).toContain('6%')
  })

  it('escalates to critical at twice the ceiling', () => {
    expect(leakageItem({ ...base, leakagePct: 10, leakingCount: 10 })?.severity).toBe('critical')
  })
})

describe('closeRateItem', () => {
  it('is null below the minimum decided sample', () => {
    expect(closeRateItem({ closeRatePct: 10, decided: 9, targetPct: 35 })).toBeNull()
  })

  it('is null when the rate meets the target', () => {
    expect(closeRateItem({ closeRatePct: 35, decided: 40, targetPct: 35 })).toBeNull()
  })

  it('warns when below target with enough sample', () => {
    const item = closeRateItem({ closeRatePct: 22, decided: 40, targetPct: 35 })
    expect(item?.severity).toBe('warning')
    expect(item?.detail).toContain('n=40')
  })
})

describe('briefAdoptionItem', () => {
  it('is null when there are no calls', () => {
    expect(briefAdoptionItem({ adoptionPct: null, callsTotal: 0 })).toBeNull()
  })

  it('is null at or above target', () => {
    expect(briefAdoptionItem({ adoptionPct: 80, callsTotal: 50 })).toBeNull()
  })

  it('is info for a modest miss', () => {
    expect(briefAdoptionItem({ adoptionPct: 65, callsTotal: 50 })?.severity).toBe('info')
  })

  it('warns for a steep miss below 60% of target', () => {
    expect(briefAdoptionItem({ adoptionPct: 40, callsTotal: 50 })?.severity).toBe('warning')
  })
})

describe('overdueItem', () => {
  it('is null with nothing overdue', () => {
    expect(overdueItem({ overdueTasks: 0 })).toBeNull()
  })

  it('bands severity by pile size', () => {
    expect(overdueItem({ overdueTasks: 3 })?.severity).toBe('info')
    expect(overdueItem({ overdueTasks: 8 })?.severity).toBe('warning')
    expect(overdueItem({ overdueTasks: 25 })?.severity).toBe('critical')
  })

  it('reads singular for one task', () => {
    expect(overdueItem({ overdueTasks: 1 })?.detail).toContain('task is')
  })
})

describe('slaItem', () => {
  it('is null when nothing is expired', () => {
    expect(slaItem({ slaExpired: 0 })).toBeNull()
  })

  it('warns and counts when clients are past SLA', () => {
    const item = slaItem({ slaExpired: 4 })
    expect(item?.severity).toBe('warning')
    expect(item?.count).toBe(4)
  })
})

describe('qualifierItem', () => {
  it('is null when the queue is clear', () => {
    expect(qualifierItem({ awaiting: 0 })).toBeNull()
  })

  it('is info with the awaiting count', () => {
    const item = qualifierItem({ awaiting: 12 })
    expect(item?.severity).toBe('info')
    expect(item?.count).toBe(12)
    expect(item?.href).toBe('/sales/qualifier')
  })
})

describe('hygieneItem', () => {
  it('is null when the book is healthy', () => {
    expect(hygieneItem({ score: 80 })).toBeNull()
    expect(hygieneItem({ score: 96 })).toBeNull()
  })

  it('warns below the healthy line and links hygiene', () => {
    const item = hygieneItem({ score: 62 })
    expect(item?.severity).toBe('warning')
    expect(item?.href).toBe('/sales/hygiene')
    expect(item?.detail).toContain('62/100')
  })
})

describe('coldCloserItem', () => {
  it('is null when no closer is cold', () => {
    expect(coldCloserItem({ coldCount: 0, sampleName: null, rangeDays: 30 })).toBeNull()
  })

  it('names the single cold closer', () => {
    const item = coldCloserItem({ coldCount: 1, sampleName: 'Dana Reyes', rangeDays: 30 })
    expect(item?.detail).toContain('Dana Reyes')
    expect(item?.title).toBe('A closer has gone quiet')
  })

  it('pluralizes for several cold closers', () => {
    const item = coldCloserItem({ coldCount: 3, sampleName: 'Dana', rangeDays: 30 })
    expect(item?.detail).toContain('3 closers')
    expect(item?.count).toBe(3)
  })
})

describe('sortAttentionItems', () => {
  const mk = (
    key: string,
    severity: AttentionItem['severity'],
    count?: number,
  ): AttentionItem => ({
    key,
    severity,
    title: key,
    detail: key,
    count,
    href: '/x',
    category: 'coverage',
  })

  it('orders critical → warning → info, then count desc within a band', () => {
    const sorted = sortAttentionItems([
      mk('info-a', 'info', 2),
      mk('warn-small', 'warning', 3),
      mk('crit', 'critical', 1),
      mk('warn-big', 'warning', 30),
    ])
    expect(sorted.map((i) => i.key)).toEqual(['crit', 'warn-big', 'warn-small', 'info-a'])
  })

  it('treats a missing count as zero without throwing', () => {
    const sorted = sortAttentionItems([mk('with', 'warning', 5), mk('without', 'warning')])
    expect(sorted.map((i) => i.key)).toEqual(['with', 'without'])
  })

  it('does not mutate the input array', () => {
    const input = [mk('a', 'info', 1), mk('b', 'critical', 1)]
    const before = input.map((i) => i.key)
    sortAttentionItems(input)
    expect(input.map((i) => i.key)).toEqual(before)
  })
})
