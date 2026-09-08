/**
 * Desktop sidebar expansion state.
 *
 * The sidebar is a collapsed icon rail by default; the user's choice persists
 * in localStorage under SIDEBAR_STORAGE_KEY. The pre-paint script in
 * src/app/layout.tsx stamps SIDEBAR_OPEN_CLASS on <html> before first paint
 * when the stored value is 'expanded', and ALL width/label/section-title
 * styling keys off that class via CSS (`[.pf-nav-open_&]:` variants) — so the
 * server-rendered HTML and the first client paint always agree and there is
 * no width flash or hydration mismatch. React state only mirrors the class
 * after hydration for ARIA and tooltip gating.
 */

export const SIDEBAR_STORAGE_KEY = 'pf-sidebar'
export const SIDEBAR_OPEN_CLASS = 'pf-nav-open'

export type SidebarState = 'expanded' | 'collapsed'

/** Only the exact token 'expanded' expands; anything else is the collapsed default. */
export function parseSidebarState(raw: string | null | undefined): SidebarState {
  return raw === 'expanded' ? 'expanded' : 'collapsed'
}

export function sidebarStateToToken(expanded: boolean): SidebarState {
  return expanded ? 'expanded' : 'collapsed'
}

type RootLike = { classList: { contains(cls: string): boolean; toggle(cls: string, force?: boolean): unknown } }
type StorageLike = { setItem(key: string, value: string): void }

/**
 * Whether the sidebar is expanded, read from the class the pre-paint script
 * stamped (authoritative — it already folded in localStorage). Returns false
 * (collapsed default) on the server or when the DOM is unavailable.
 */
export function readSidebarExpanded(root?: RootLike): boolean {
  try {
    const el = root ?? document.documentElement
    return el.classList.contains(SIDEBAR_OPEN_CLASS)
  } catch {
    return false
  }
}

/**
 * Persist a toggle: stamp/remove the html class (CSS drives the width off it)
 * and store the choice. Each side is independently guarded so a blocked
 * localStorage still lets the class — and therefore the UI — update.
 */
export function persistSidebarExpanded(expanded: boolean, root?: RootLike, storage?: StorageLike): void {
  try {
    const el = root ?? document.documentElement
    el.classList.toggle(SIDEBAR_OPEN_CLASS, expanded)
  } catch {
    /* no DOM (server) — nothing to stamp */
  }
  try {
    const store = storage ?? localStorage
    store.setItem(SIDEBAR_STORAGE_KEY, sidebarStateToToken(expanded))
  } catch {
    /* storage blocked — the choice just won't survive a reload */
  }
}
