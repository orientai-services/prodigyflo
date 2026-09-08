import type { ComponentType } from 'react'
import { Building2, Landmark } from 'lucide-react'
import { cn } from '@/lib/utils'
import { BrandGlyph, BrandMark } from '@/components/brand-mark'
import { ScsMark } from '@/components/brand/scs-mark'

/**
 * Per-account branding for the agency org tree.
 *
 * ProdigyFlo is the agency's own product, but a user who has switched into a
 * client account is working inside that client's world — the switcher, the
 * sidebar mark, the installed app's icon and its name all follow the ACTIVE
 * account, not the agency. Anything else and someone in SCS all day is looking
 * at a ProdigyFlo logo and an app on their home screen that says ProdigyFlo.
 *
 * Keyed by SLUG, not id or name: ids differ between the seed, staging and
 * production databases, and names are user-editable in the agency console —
 * either would silently drop the branding the moment someone renamed an
 * account. Slugs are unique and stable.
 *
 * An account with no entry falls back to the agency's own mark and icons, so
 * adding a client account never requires touching this file. `prodigyflo` has
 * an entry anyway because it needs real icon files like everyone else.
 */
type OrgMarkComponent = ComponentType<{ className?: string }>

export type OrgBrand = {
  /** Installed-app name. Kept short — Android truncates past ~12 chars. */
  shortName: string
  /** Long name, for the manifest and the document title. */
  name: string
  /** PWA theme colour. Must be a literal: the manifest is JSON, not CSS. */
  themeColor: string
  backgroundColor: string
  /** `public/brand/<iconDir>/…` — see the four files each directory holds. */
  iconDir: string
  /** Row icon, at 16px. */
  Mark: OrgMarkComponent
  /** Sidebar wordmark. Rendered at the caller's font size. */
  wordmark: string
}

const BRANDS: Record<string, OrgBrand> = {
  scs: {
    shortName: 'SCS',
    name: 'Solar Contract Services',
    themeColor: '#0D1B2A',
    backgroundColor: '#F7F5EF',
    iconDir: 'scs',
    Mark: ScsMark,
    wordmark: 'SCS',
  },
  prodigyflo: {
    shortName: 'ProdigyFlo',
    name: 'ProdigyFlo',
    // The mark's own navy, not the derived --brand: this paints the PWA splash
    // and the browser chrome, which are brand surfaces, not interface ones.
    themeColor: '#0A1937',
    backgroundColor: '#FFFFFF',
    iconDir: 'prodigyflo',
    Mark: BrandGlyph,
    wordmark: 'ProdigyFlo',
  },
}

/** Every slug with its own icon set — the manifest route prerenders these. */
export const BRANDED_SLUGS = Object.keys(BRANDS)

/** The agency's own branding, used whenever an account has none of its own. */
export const DEFAULT_BRAND = BRANDS.prodigyflo

export function orgBrand(slug?: string | null): OrgBrand | undefined {
  return slug ? BRANDS[slug] : undefined
}

/** Resolved branding for an account, falling back to the agency's. */
export function brandFor(slug?: string | null): OrgBrand {
  return orgBrand(slug) ?? DEFAULT_BRAND
}

/** True when the account ships its own mark — lets callers skip a muted tint. */
export function hasOrgMark(slug?: string | null): boolean {
  return Boolean(orgBrand(slug))
}

/**
 * The mark for one account. `kind` only decides the FALLBACK — a branded
 * account uses its own mark whether it is the agency or a client.
 */
export function OrgMark({
  slug,
  kind,
  className,
}: {
  slug?: string
  kind?: string
  className?: string
}) {
  const brand = orgBrand(slug)
  if (brand) return <brand.Mark className={className} />
  const Fallback = kind === 'AGENCY' ? Landmark : Building2
  return <Fallback className={className} />
}

/**
 * The shell's masthead lockup, for the ACTIVE account.
 *
 * Falls through to `BrandMark` — not to a generic icon — because an unbranded
 * client account is still being worked inside ProdigyFlo, and a building glyph
 * in the masthead would read as a broken image rather than a deliberate blank.
 *
 * The wordmark is the SHORT name on purpose. The sidebar rail is 240px wide at
 * its widest and the org switcher immediately below already spells the account
 * out in full, so repeating "Solar Contract Services" here buys nothing and
 * overflows at the first slightly longer client name.
 */
export function AppBrand({
  slug,
  showWordmark = true,
  className,
}: {
  slug?: string | null
  showWordmark?: boolean
  className?: string
}) {
  const brand = orgBrand(slug)
  if (!brand || brand === DEFAULT_BRAND) {
    return <BrandMark showWordmark={showWordmark} className={className} />
  }
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <brand.Mark className="h-full w-auto shrink-0" />
      {showWordmark && (
        <span className="text-[1.05em] leading-none font-semibold tracking-tight">
          {brand.wordmark}
        </span>
      )}
      <span className="sr-only">{brand.name}</span>
    </span>
  )
}
