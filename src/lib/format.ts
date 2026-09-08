type Numeric = number | string | { toString(): string } | null | undefined

function toNumber(value: Numeric): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value.toString())
  return Number.isFinite(n) ? n : null
}

export function currency(value: Numeric, opts: { compact?: boolean; cents?: boolean } = {}): string {
  const n = toNumber(value)
  if (n === null) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: opts.compact ? 'compact' : 'standard',
    maximumFractionDigits: opts.cents ? 2 : 0,
    minimumFractionDigits: opts.cents ? 2 : 0,
  }).format(n)
}

export function number(value: Numeric, opts: { compact?: boolean } = {}): string {
  const n = toNumber(value)
  if (n === null) return '—'
  return new Intl.NumberFormat('en-US', {
    notation: opts.compact ? 'compact' : 'standard',
    maximumFractionDigits: opts.compact ? 1 : 0,
  }).format(n)
}

export function percent(value: Numeric, digits = 0): string {
  const n = toNumber(value)
  if (n === null) return '—'
  return `${n.toFixed(digits)}%`
}

/** Safe rate: returns null rather than NaN or Infinity when the base is zero. */
export function rate(numerator: number, denominator: number): number | null {
  if (!denominator) return null
  return (numerator / denominator) * 100
}

export function shortDate(value: Date | string | null | undefined): string {
  if (!value) return '—'
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function dateTime(value: Date | string | null | undefined, timeZone?: string): string {
  if (!value) return '—'
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone, timeZoneName: 'short' } : {}),
  })
}

export function relativeTime(value: Date | string | null | undefined): string {
  if (!value) return '—'
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return '—'

  const diffMs = Date.now() - d.getTime()
  const abs = Math.abs(diffMs)
  const rtf = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' })

  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000_000],
    ['month', 2_592_000_000],
    ['week', 604_800_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ]
  for (const [unit, ms] of units) {
    if (abs >= ms) return rtf.format(-Math.round(diffMs / ms), unit)
  }
  return 'just now'
}

/** "3d 4h" style duration from a minute count. */
export function duration(minutes: Numeric): string {
  const n = toNumber(minutes)
  if (n === null || n < 0) return '—'
  if (n < 60) return `${Math.round(n)}m`
  const hours = n / 60
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`
  const days = Math.floor(hours / 24)
  const rem = Math.round(hours % 24)
  return rem ? `${days}d ${rem}h` : `${days}d`
}

export function hoursBetween(from: Date | string, to: Date | string = new Date()): number {
  const a = typeof from === 'string' ? new Date(from) : from
  const b = typeof to === 'string' ? new Date(to) : to
  return (b.getTime() - a.getTime()) / 3_600_000
}

export function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

export function fullName(person: { firstName: string; lastName: string }): string {
  return `${person.firstName} ${person.lastName}`
}

/** Turns SCREAMING_SNAKE enum values into readable text. */
export function humanize(value: string): string {
  return value
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase())
}

/**
 * Serializable format descriptor.
 *
 * Charts are client components rendered from server components, so a formatter
 * has to cross the RSC boundary as data, not as a function.
 */
export type ValueFormat =
  | 'currency'
  | 'currencyCompact'
  | 'currencyCents'
  | 'number'
  | 'numberCompact'
  | 'percent'
  | 'percent1'
  | 'hours'
  | 'ratio'

export function formatValue(value: Numeric, kind: ValueFormat): string {
  switch (kind) {
    case 'currency':
      return currency(value)
    case 'currencyCompact':
      return currency(value, { compact: true })
    case 'currencyCents':
      return currency(value, { cents: true })
    case 'number':
      return number(value)
    case 'numberCompact':
      return number(value, { compact: true })
    case 'percent':
      return percent(value)
    case 'percent1':
      return percent(value, 1)
    case 'hours':
      return duration(toNumber(value) === null ? null : (toNumber(value) as number) * 60)
    case 'ratio': {
      const n = toNumber(value)
      return n === null ? '—' : `${n.toFixed(2)}×`
    }
  }
}

/**
 * Human file size. Small files are shown in bytes rather than rounding to
 * "0 KB", which reads as a broken upload.
 */
export function fileSize(bytes: number | null | undefined): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
