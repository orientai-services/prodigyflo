'use client'

import { useEffect, useState, useTransition } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Loader2, Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'

type Option = { value: string; label: string }

function Select({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string
  options: Option[]
  placeholder: string
  onChange: (value: string) => void
}) {
  return (
    <NativeSelect
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={placeholder}
      className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-md border px-2 text-sm outline-none focus-visible:ring-3"
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </NativeSelect>
  )
}

export function InboundFilters({
  categories,
  connectors,
}: {
  categories: Option[]
  connectors: Option[]
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [pending, startTransition] = useTransition()
  const [q, setQ] = useState(params.get('search') ?? '')

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString())
    if (value) next.set(key, value)
    else next.delete(key)
    next.delete('page') // a changed filter always restarts pagination
    startTransition(() => router.push(`${pathname}?${next}`))
  }

  // Debounce free-text search so a request doesn't fire on every keystroke.
  useEffect(() => {
    const current = params.get('search') ?? ''
    if (q === current) return
    const timer = setTimeout(() => set('search', q), 350)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  const activeKeys = ['search', 'category', 'source', 'since', 'until']
  const active = activeKeys.filter((k) => params.get(k))

  const clearAll = () => {
    setQ('')
    const next = new URLSearchParams(params.toString())
    for (const k of activeKeys) next.delete(k)
    next.delete('page')
    startTransition(() => router.push(`${pathname}?${next}`))
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Summary, external id, or type"
          aria-label="Search inbound events"
          className="h-8 w-60 pl-8"
        />
      </div>

      <Select
        placeholder="Any category"
        value={params.get('category') ?? ''}
        options={categories}
        onChange={(v) => set('category', v)}
      />

      {connectors.length > 0 && (
        <Select
          placeholder="Any connector"
          value={params.get('source') ?? ''}
          options={connectors}
          onChange={(v) => set('source', v)}
        />
      )}

      <label className="text-muted-foreground flex items-center gap-1 text-xs">
        <span className="sr-only">From date</span>
        <Input
          type="date"
          value={params.get('since') ?? ''}
          onChange={(e) => set('since', e.target.value)}
          aria-label="From date"
          className="h-8 w-[9.5rem]"
        />
      </label>
      <label className="text-muted-foreground flex items-center gap-1 text-xs">
        <span className="sr-only">To date</span>
        <Input
          type="date"
          value={params.get('until') ?? ''}
          onChange={(e) => set('until', e.target.value)}
          aria-label="To date"
          className="h-8 w-[9.5rem]"
        />
      </label>

      {pending && <Loader2 className="text-muted-foreground size-4 animate-spin" />}

      {active.length > 0 && (
        <Button variant="ghost" size="sm" onClick={clearAll} className="h-8 gap-1 text-xs">
          <X className="size-3.5" />
          Clear
        </Button>
      )}
    </div>
  )
}
