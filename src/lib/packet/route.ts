import type { Path, Trench } from './schema'
import { str } from './schema'

const DEAD = new Set(['mosaic', 'sunlight financial', 'sunlight'])

export function routePath(input: {
  lender: string
  sale_or_refi?: string
  has_contract: boolean
}): Path {
  if (!input.has_contract) return 'collection'
  const lender = str(input.lender).toLowerCase()
  if ([...DEAD].some((d) => lender.includes(d))) return 'tradebloc_dc_capital'
  return 'scs_closer'
}

export function feeTrench(contractValue: unknown): Trench {
  const n = Number(String(contractValue ?? '').replace(/[^0-9.]/g, ''))
  if (!Number.isFinite(n) || n <= 0) return 'unknown'
  if (n < 40000) return '0_39'
  if (n < 60000) return '40_59'
  return '60_plus'
}

export function trenchLabel(t: Trench): string {
  return { '0_39': '$0–39k', '40_59': '$40–59k', '60_plus': '$60k+', unknown: 'UNKNOWN' }[t]
}

export function pathLabel(p: Path): string {
  return {
    scs_closer: 'SCS closer',
    tradebloc_dc_capital: 'Tradebloc / DC Capital',
    collection: 'Collection only',
    recovery: 'Recovery',
  }[p]
}
