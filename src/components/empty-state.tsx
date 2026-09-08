import * as Icons from 'lucide-react'
import { cn } from '@/lib/utils'
import { BrandMark } from '@/components/brand-mark'

export function EmptyState({
  icon = 'Inbox',
  title,
  description,
  action,
  illustration,
  className,
}: {
  icon?: string
  title: string
  description?: string
  action?: React.ReactNode
  /**
   * Optional visual above the copy. Pass `'brand'` for the built-in
   * BrandMark illustration (glyph tile with the icon as a badge), or any
   * ReactNode for a custom one. Omitted → the classic icon circle.
   */
  illustration?: 'brand' | React.ReactNode
  className?: string
}) {
  const Icon =
    (Icons as unknown as Record<string, React.ComponentType<{ className?: string }>>)[icon] ?? Icons.Inbox

  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      {illustration ? (
        illustration === 'brand' ? (
          <div aria-hidden className="relative">
            <div className="bg-brand-soft flex size-14 items-center justify-center rounded-2xl border">
              <BrandMark showWordmark={false} className="h-7 opacity-80" />
            </div>
            <div className="bg-card shadow-e1 absolute -right-2 -bottom-2 flex size-7 items-center justify-center rounded-full border">
              <Icon className="text-muted-foreground size-3.5" />
            </div>
          </div>
        ) : (
          illustration
        )
      ) : (
        <div className="bg-muted flex size-10 items-center justify-center rounded-full">
          <Icon className="text-muted-foreground size-5" />
        </div>
      )}
      <p className="mt-3 text-sm font-medium">{title}</p>
      {description && <p className="text-muted-foreground mt-1 max-w-sm text-sm">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
