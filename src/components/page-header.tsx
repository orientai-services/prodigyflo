import { cn } from '@/lib/utils'

export function PageHeader({
  title,
  description,
  actions,
  className,
  children,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
  className?: string
  children?: React.ReactNode
}) {
  return (
    <div className={cn('border-b px-4 py-5 sm:px-6', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight max-sm:text-lg max-sm:text-balance max-sm:whitespace-normal">{title}</h1>
          {description && <p className="text-muted-foreground mt-1 text-sm">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2 max-sm:max-w-full max-sm:flex-wrap">{actions}</div>}
      </div>
      {children}
    </div>
  )
}
