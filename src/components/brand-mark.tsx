import { cn } from '@/lib/utils'

/**
 * ProdigyFlo — the flowing "P".
 *
 * WHY THIS IS A VECTOR SIMPLIFICATION AND NOT THE SUPPLIED ARTWORK
 * ---------------------------------------------------------------
 * The approved logo is a painterly brushstroke: dry-brush texture, speckle, a
 * white swash breaking out of the tile. It is beautiful at 512px and it is an
 * unreadable smudge at 32px — rendered down, the ribbon and the counter of the
 * P merge into one blob and the letter disappears. Measured side by side, the
 * real art stops reading as a "P" somewhere below ~64px.
 *
 * So the artwork is used where it has room (the PWA and Apple touch icons, 180px
 * and up, in `public/brand/prodigyflo/`) and this redraw is used everywhere in
 * the interface, where the mark is 24–28px. It keeps the ribbon's gesture, the
 * counter, and the navy→aqua sweep, in geometry that survives a 16px favicon.
 *
 * COLOURS ARE LITERALS ON PURPOSE. A logotype is exempt from WCAG contrast
 * (1.4.3) and has to match the brand exactly; the interface accent derived from
 * this teal is `--brand`, which is a different, darker value because it has to
 * carry body text. Never swap one for the other — see the brand layer note in
 * globals.css.
 */
const NAVY = '#0A1937'
const TEAL = '#55BAC2'

/**
 * The tile alone. Sized by the caller's height, as `BrandMark` sizes it.
 *
 * ── FLAT TEAL, NOT A GRADIENT, AND THAT IS A BUG FIX ─────────────────────
 * This drew the ribbon with a `<linearGradient>` referenced as
 * `stroke="url(#pf-mark-ribbon)"`. In production the tile rendered EMPTY —
 * a plain navy square with no P — and only inside the app shell.
 *
 * The shell paints the mark four times (desktop rail expanded, desktop rail
 * collapsed, mobile drawer, mobile header) and CSS-toggles them with `hidden`.
 * Every instance carried its own copy of the gradient under the SAME id, so
 * every `url(#…)` in the document resolved to the FIRST one — which lives in a
 * `display:none` subtree. Chrome does not lay that subtree out, the paint
 * server never resolves, and a path with `fill="none"` and an unresolvable
 * stroke paints nothing at all. Silently: no console error, no fallback.
 *
 * The fixes that keep a gradient both cost more than the gradient is worth:
 * `useId()` needs this to become a client component (it is rendered from server
 * components on the auth pages), and an id prop pushes the problem onto every
 * caller. Rendered side by side at 24px, 44px and 128px, the flat stroke is
 * indistinguishable from the gradient — the sweep only reads above ~200px,
 * which is the ARTWORK's territory, not this redraw's.
 *
 * The gradient survives in public/brand/prodigyflo/mark.svg, which is a
 * standalone document where the id cannot collide, and which is what the
 * favicon and the maskable icon were rasterised from.
 *
 * If you reintroduce a paint-server reference here, check it in the app shell
 * with the sidebar COLLAPSED, not just on the login page.
 */
export function BrandGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('h-full w-auto shrink-0', className)} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill={NAVY} />
      {/*
        A LETTER FIRST, a ribbon second.

        The first draft made the stem an S-curve and hung a small closed bowl
        off it. Read cold at any size that is not a "P" — it is a tadpole, and
        it was called exactly that. A P needs two things this path now has: a
        stem that is essentially VERTICAL over its whole height, and a bowl that
        visibly CLOSES BACK onto that stem rather than floating beside it.

        What is left of the brand's flow is deliberate and small: the stem drifts
        ~0.6 units right at the foot, and the bowl is rounder and more generous
        than a text P's would be. Enough to feel drawn rather than typeset;
        not enough to stop being a letter.

        Drawn as a stroke rather than a filled outline so the weight stays even
        as it scales, and so one number controls legibility.
      */}
      <path
        d="M13.1 26.9 C 12.1 21.4, 12.1 12.2, 12.8 6.7 C 19.6 5.3, 26.2 8, 26.4 12.8 C 26.6 17.8, 20 20.4, 12.5 20"
        fill="none"
        stroke={TEAL}
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Mark plus wordmark. `tagline` adds the rule-flanked "Capture. Nurture.
 * Close." — for full-bleed brand moments, not for app chrome, where a 14px
 * header is not the place for a third line of type.
 *
 * The three beats are the product's actual order of operations (intake →
 * sequences → pipeline), which is why the punctuation stays: tracked out at
 * 0.24em the periods are what keep it reading as three statements rather than
 * one run-on phrase.
 */
export function BrandMark({
  className,
  showWordmark = true,
  tagline = false,
}: {
  className?: string
  showWordmark?: boolean
  tagline?: boolean
}) {
  if (tagline) {
    return (
      <span className={cn('inline-flex flex-col items-center gap-2', className)}>
        <span className="inline-flex items-center gap-2">
          <BrandGlyph className="h-11" />
          <Wordmark className="text-[2rem]" />
        </span>
        <span className="flex w-full items-center gap-2">
          <span className="bg-brand/40 h-px flex-1" />
          <span className="text-muted-foreground text-[0.65rem] font-medium tracking-[0.24em] whitespace-nowrap uppercase">
            Capture. Nurture. Close.
          </span>
          <span className="bg-brand/40 h-px flex-1" />
        </span>
        <span className="sr-only">ProdigyFlo — Capture. Nurture. Close.</span>
      </span>
    )
  }

  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <BrandGlyph />
      {showWordmark && <Wordmark />}
      <span className="sr-only">ProdigyFlo</span>
    </span>
  )
}

/**
 * "Prodigy" in the ink colour, "Flo" in the brand.
 *
 * `text-brand` rather than the logo's literal teal: this sits on app chrome at
 * 14–17px, where the pale logo teal measures 2.3:1 on white. The logotype's
 * exemption covers the lockup on a brand surface, not a wordmark being used as
 * interface furniture.
 */
function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('text-[1.05em] leading-none font-semibold tracking-tight', className)}>
      Prodigy<span className="text-brand">Flo</span>
    </span>
  )
}
