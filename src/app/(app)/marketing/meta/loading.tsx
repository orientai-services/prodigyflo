import { Skeleton } from '@/components/ui/skeleton'

export default function MetaAdsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading Meta Ads">
      <div className="border-b px-4 py-5 sm:px-6">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="mt-2 h-4 w-72 max-w-full" />
        <div className="mt-3 flex gap-2">
          <Skeleton className="h-5 w-12 rounded-full" />
          <Skeleton className="h-5 w-28 rounded-full" />
        </div>
        <div className="mt-4 flex gap-1.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-24 rounded-full" />
          ))}
        </div>
      </div>
      <div className="space-y-4 p-4 sm:p-6">
        {/* View tabs: Overview, Ads, Funnel, Cycle (+ Billing, Connection for managers). */}
        <div className="flex gap-1.5 overflow-hidden">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-20 shrink-0 rounded-full" />
          ))}
        </div>
        <div className="flex gap-1.5 overflow-hidden">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-16 shrink-0 rounded-full" />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-64 rounded-lg" />
          <Skeleton className="h-64 rounded-lg" />
        </div>
        <Skeleton className="h-36 rounded-lg" />
      </div>
    </div>
  )
}
