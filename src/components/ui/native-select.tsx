import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * A native select that looks like the rest of the control set.
 *
 * Deliberately native rather than a listbox widget: these sit inside forms that
 * post to server actions, so `name`/`value` semantics matter, and the platform
 * picker is better on touch.
 *
 * The border, height and padding live on the wrapper rather than the select
 * itself. A shrink-to-fit `<select>` computes its intrinsic width from the
 * longest option plus the platform's own arrow allowance, ignoring any
 * padding-right we set — so an overlaid chevron collides with the text on short
 * option lists. Giving the chevron its own grid column makes the width correct
 * by construction.
 */
export function NativeSelect({
  className,
  size = 'default',
  // `size` is omitted from the base props: a native select's own `size` is a
  // row count, and intersecting it with our union resolves to `never`.
  ...props
}: Omit<React.ComponentProps<'select'>, 'size'> & { size?: 'sm' | 'default' }) {
  return (
    <div
      data-slot="native-select"
      className={cn(
        'border-input bg-background text-foreground relative inline-grid',
        'grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5 rounded-md border',
        'transition-[color,box-shadow,border-color]',
        'focus-within:border-ring focus-within:ring-ring/40 focus-within:ring-[3px]',
        'has-disabled:cursor-not-allowed has-disabled:opacity-50',
        'has-aria-invalid:border-danger has-aria-invalid:ring-danger/20',
        size === 'sm' ? 'h-8 pr-2 pl-2.5 text-sm' : 'h-9 pr-2.5 pl-3 text-sm',
        className,
      )}
    >
      <select
        className="peer col-start-1 w-full min-w-0 appearance-none truncate bg-transparent pr-0 outline-none"
        {...props}
      />
      <svg
        aria-hidden="true"
        viewBox="0 0 12 12"
        className="text-muted-foreground peer-focus-visible:text-foreground pointer-events-none col-start-2 size-3 transition-colors"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 4.5 6 7.5 9 4.5" />
      </svg>
    </div>
  )
}
