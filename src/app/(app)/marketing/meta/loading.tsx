import { Skeleton } from '@/components/ui/skeleton'

export default function MetaAdsLoading() {
  return (
    <div>
      <div className="border-b px-4 py-5 sm:px-6">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="mt-2 h-4 w-72" />
        <div className="mt-4 flex gap-1.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-24 rounded-full" />
          ))}
        </div>
      </div>
      <div className="space-y-4 p-4 sm:p-6">
        <Skeleton className="h-16 rounded-lg" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-72 rounded-lg" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
    </div>
  )
}
