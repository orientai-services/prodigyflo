/**
 * Phone treatment for wide data tables that already sit in their own
 * horizontal scroll container (`scroll-x`): below `md` the first column stays
 * pinned while the rest of the row scrolls, so a row never loses its name.
 * Every rule is `max-md:` — tablet and desktop render exactly as before.
 *
 * Usage: `<div className={cn('scroll-x', STICKY_FIRST_COL)}><table>…`
 */
export const STICKY_FIRST_COL = [
  'max-md:[&_:is(th,td):first-child]:sticky',
  'max-md:[&_:is(th,td):first-child]:left-0',
  'max-md:[&_:is(th,td):first-child]:z-10',
  'max-md:[&_:is(th,td):first-child]:shadow-[inset_-1px_0_0_var(--border)]',
  'max-md:[&_td:first-child]:bg-card',
  'max-md:[&_th:first-child]:bg-surface-sunk',
].join(' ')
