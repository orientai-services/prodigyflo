import { cn } from '@/lib/utils'

/**
 * SCS — Solar Contract Services.
 *
 * The client account's own mark, redrawn as geometry from the approved brand
 * board (gold roof chevron over document rules). The supplied brand package
 * ships only raster crops of that board — soft-edged, shadowed, several
 * lockups per file — which turn to mush at the 16px the org switcher renders
 * at. This is the same identity as the SCS website's marks; the two live in
 * separate repos because they deploy separately, so keep them in step by hand
 * if the brand ever moves.
 *
 * Deliberately NOT the circular seal: the brand guide forbids the seal
 * anywhere the ring wording would be shrunk past legibility, and a menu row
 * is exactly that.
 */

const SCS_NAVY = '#0D1B2A'
const SCS_GOLD = '#D4AF37'
const SCS_CREAM = '#F7F5EF'

/**
 * Tile rendering — the app-icon form. A tile rather than a bare chevron
 * because this mark sits in a row of monochrome lucide icons that inherit the
 * theme's foreground: a two-colour glyph with no ground would read as a
 * rendering artefact next to them, and gold-on-white does not clear 3:1.
 *
 * Two rules, not three, and a heavier chevron: below ~24px the three-rule
 * drawing antialiases into one grey block.
 */
export function ScsMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={cn('size-4 shrink-0', className)}
      role="img"
      aria-label="Solar Contract Services"
    >
      <rect width="64" height="64" rx="12" fill={SCS_NAVY} />
      <path
        d="M9 32 32 10l23 22"
        fill="none"
        stroke={SCS_GOLD}
        strokeWidth="7"
        strokeLinejoin="miter"
        strokeMiterlimit="6"
      />
      <g fill={SCS_CREAM}>
        <rect x="20" y="37" width="24" height="7" />
        <rect x="20" y="50" width="24" height="7" />
      </g>
    </svg>
  )
}
