'use client' // Error boundaries must be Client Components

import { useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/empty-state'

/** Plain message and a retry. No stack, no ids, no Meta error text. */
export default function MetaAdsError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  useEffect(() => {
    // The digest lets an admin find the server log line; nothing else is logged here.
    if (error.digest) console.error('[meta-ads] page failed', error.digest)
  }, [error])

  return (
    <div className="p-4 sm:p-6">
      <Card>
        <EmptyState
          icon="AlertTriangle"
          illustration={
            <div className="bg-muted flex size-10 items-center justify-center rounded-full">
              <AlertTriangle aria-hidden className="text-warning size-5" />
            </div>
          }
          title="We couldn't load the ads page."
          description="This is usually temporary."
          action={<Button className="h-10 sm:h-8" onClick={() => retry()}>Try again</Button>}
        />
      </Card>
    </div>
  )
}
