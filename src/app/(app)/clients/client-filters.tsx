'use client'

import { useEffect, useState, useTransition } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Loader2, Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'

type Option = { value: string; label: string }

function Select({
  name,
  value,
  options,
  placeholder,
  onChange,
}: {
  name: string
  value: string
  options: Option[]
  placeholder: string
  onChange: (value: string) => void
}) {
  return (
    <NativeSelect
      name={name}
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

export function ClientFilters({
  stages,
  owners,
  teams,
  canFilterOwner,
}: {
  stages: { key: string; name: string }[]
  owners: { id: string; name: string }[]
  teams: { id: string; name: string }[]
  canFilterOwner: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [pending, startTransition] = useTransition()
  const [q, setQ] = useState(params.get('q') ?? '')

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString())
    if (value) next.set(key, value)
    else next.delete(key)
    next.delete('page') // a new filter always starts at page 1
    startTransition(() => router.push(`${pathname}?${next}`))
  }

  // Debounce the free-text search so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const current = params.get('q') ?? ''
    if (q === current) return
    const timer = setTimeout(() => set('q', q), 350)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  const active = ['q', 'stage', 'owner', 'team', 'status'].filter((k) => params.get(k))

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Name, email, or phone"
          aria-label="Search clients"
          className="h-8 w-56 pl-8"
        />
      </div>

      <Select
        name="stage"
        placeholder="Any stage"
        value={params.get('stage') ?? ''}
        options={stages.map((s) => ({ value: s.key, label: s.name }))}
        onChange={(v) => set('stage', v)}
      />

      {canFilterOwner && (
        <Select
          name="owner"
          placeholder="Any owner"
          value={params.get('owner') ?? ''}
          options={owners.map((o) => ({ value: o.id, label: o.name }))}
          onChange={(v) => set('owner', v)}
        />
      )}

      {canFilterOwner && teams.length > 0 && (
        <Select
          name="team"
          placeholder="Any team"
          value={params.get('team') ?? ''}
          options={teams.map((t) => ({ value: t.id, label: t.name }))}
          onChange={(v) => set('team', v)}
        />
      )}

      <Select
        name="status"
        placeholder="Any status"
        value={params.get('status') ?? ''}
        options={[
          { value: 'ACTIVE', label: 'Active' },
          { value: 'ON_HOLD', label: 'On hold' },
          { value: 'DISQUALIFIED', label: 'Disqualified' },
          { value: 'CLOSED_WON', label: 'Closed won' },
          { value: 'CLOSED_LOST', label: 'Closed lost' },
        ]}
        onChange={(v) => set('status', v)}
      />

      <Select
        name="sort"
        placeholder="Recent activity"
        value={params.get('sort') ?? ''}
        options={[
          { value: 'recent', label: 'Recent activity' },
          { value: 'oldest', label: 'Least recent activity' },
          { value: 'value', label: 'Highest value' },
          { value: 'created', label: 'Newest' },
          { value: 'name', label: 'Name A–Z' },
        ]}
        onChange={(v) => set('sort', v)}
      />

      {active.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setQ('')
            startTransition(() => router.push(pathname))
          }}
        >
          <X className="size-3.5" />
          Clear
        </Button>
      )}

      {pending && <Loader2 className="text-muted-foreground size-3.5 animate-spin" />}
    </div>
  )
}
