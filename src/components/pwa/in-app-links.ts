/**
 * Which `target="_blank"` links an installed app keeps in its own window.
 *
 * On a desk, "Open the full file ↗" opening a tab is what you want. In a
 * home-screen app there are no tabs: iOS opens the link in a Safari sheet,
 * which is exactly the "browser buttons" the owner complained about, and can
 * carry a different sign-in. So in standalone mode a same-origin PAGE link
 * navigates in place.
 *
 * Files and everything else keep their new window on purpose: a PDF or an
 * export opened in place would strand the user with no back button, while the
 * system sheet has Done. Those are: anything under /api/, Next's own assets,
 * paths with a file extension, and links marked `download`. Other origins
 * (Meet, chat files, maps) always open in the system browser.
 */
export function inAppHref(anchor: { href: string; hasAttribute(name: string): boolean }, origin: string): string | null {
  if (anchor.hasAttribute('download')) return null
  let url: URL
  try {
    url = new URL(anchor.href, origin)
  } catch {
    return null
  }
  if (url.origin !== origin) return null
  const path = url.pathname
  if (/^\/(api|_next|brand|pdfjs|splash|pwa|manifest)(\/|$)/.test(path)) return null
  if (/\.[a-z0-9]{1,5}$/i.test(path)) return null
  return path + url.search + url.hash
}
