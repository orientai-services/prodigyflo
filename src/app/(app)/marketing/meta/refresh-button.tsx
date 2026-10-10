'use client'

import { useTransition } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { refreshAdsNow } from './ads-actions'

/** "Refresh now" for managers. The 2-minute limit and the sync lease live on the server. */
export function RefreshButton() {
  const [pending, startTransition] = useTransition()

  function refresh() {
    startTransition(async () => {
      const res = await refreshAdsNow()
      if (res.ok) toast.success(res.ok)
      if (res.error) toast.error(res.error)
    })
  }

  return (
    <Button type="button" variant="outline" className="h-10 sm:h-8" onClick={refresh} disabled={pending}>
      <RefreshCw data-icon="inline-start" className={cn(pending && 'motion-safe:animate-spin')} />
      {pending ? 'Refreshing…' : 'Refresh now'}
    </Button>
  )
}
