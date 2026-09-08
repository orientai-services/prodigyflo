'use client'

import { useEffect, useState, useTransition } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Loader2, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'

export function DocumentSearch() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [pending, startTransition] = useTransition()
  const [q, setQ] = useState(params.get('search') ?? '')

  useEffect(() => {
    const current = params.get('search') ?? ''
    if (q === current) return
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params.toString())
      if (q) next.set('search', q)
      else next.delete('search')
      startTransition(() => router.push(`${pathname}?${next}`))
    }, 350)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  return (
    <div className="relative">
      <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Document, client, or external id"
        aria-label="Search inbound documents"
        className="h-8 w-64 pl-8"
      />
      {pending && (
        <Loader2 className="text-muted-foreground absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 animate-spin" />
      )}
    </div>
  )
}
