import type { StageCategory, StageKey } from '@prisma/client'
import { cn } from '@/lib/utils'
import { CATEGORY_STYLES, STAGE_BY_KEY } from '@/lib/pipeline'

export function StageBadge({
  stageKey,
  name,
  category,
  className,
}: {
  stageKey: StageKey
  name?: string
  category?: StageCategory
  className?: string
}) {
  const def = STAGE_BY_KEY.get(stageKey)
  const cat = category ?? def?.category ?? 'INTAKE'
  const style = CATEGORY_STYLES[cat]

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        style.badge,
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full', style.dot)} aria-hidden />
      {name ?? def?.name ?? stageKey}
    </span>
  )
}
