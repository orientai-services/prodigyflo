/**
 * Creative summary (B6): headline, body, call to action and link host from an
 * ad's `creative{...}` expansion. Handles classic link/video ads and Advantage+
 * creatives that use `asset_feed_spec`. Pure.
 */

export type CreativeSummary = {
  thumbnailUrl: string | null
  headline: string | null
  body: string | null
  cta: string | null
  linkUrl: string | null
}

type Obj = Record<string, unknown>

const str = (v: unknown, max = 500): string | null => {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s ? s.slice(0, max) : null
}
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const firstText = (v: unknown, key = 'text'): string | null => {
  if (!Array.isArray(v)) return null
  for (const item of v) {
    const s = str(obj(item)?.[key])
    if (s) return s
  }
  return null
}

/** Meta CTA codes ("LEARN_MORE") → "Learn more". */
export function ctaWords(code: string | null): string | null {
  if (!code) return null
  const w = code.toLowerCase().replace(/_/g, ' ').trim()
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : null
}

export function summarizeCreative(raw: unknown): CreativeSummary {
  const c = obj(raw) ?? {}
  const story = obj(c.object_story_spec)
  const link = obj(story?.link_data)
  const video = obj(story?.video_data)
  const feed = obj(c.asset_feed_spec)

  const headline =
    str(c.title) ?? str(link?.name) ?? str(video?.title) ?? firstText(feed?.titles) ?? null
  const body =
    str(c.body, 2000) ?? str(link?.message, 2000) ?? str(video?.message, 2000) ?? firstText(feed?.bodies) ?? null

  const linkCta = obj(link?.call_to_action) ?? obj(video?.call_to_action)
  const ctaCode =
    str(c.call_to_action_type) ??
    str(linkCta?.type) ??
    (Array.isArray(feed?.call_to_action_types) ? str((feed!.call_to_action_types as unknown[])[0]) : null)

  const linkUrl =
    str(c.link_url, 2000) ??
    str(link?.link, 2000) ??
    str(obj(linkCta?.value)?.link, 2000) ??
    firstText(feed?.link_urls, 'website_url')

  return {
    thumbnailUrl: str(c.thumbnail_url, 2000) ?? str(video?.image_url, 2000),
    headline,
    body,
    cta: ctaWords(ctaCode),
    linkUrl,
  }
}

/** Hostname only (never the path or query, which can carry tracking ids). */
export function linkHost(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.replace(/^www\./, '') : null
  } catch {
    return null
  }
}

/** Only http(s) thumbnails are ever shown. */
export function safeThumbnail(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null
  } catch {
    return null
  }
}
