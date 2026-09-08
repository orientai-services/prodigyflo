import { normalizeMime } from './sniff'

/**
 * Vision-OCR routing: which uploaded images can be read by the Anthropic
 * image-content-block path in `src/lib/ai/extraction-provider.ts`.
 *
 * The upload pipeline accepts HEIC, but the model API does not — HEIC (and
 * anything else unlisted) returns null here and keeps today's no-OCR
 * behavior: an explicit "this image was not read" warning instead of
 * invented text.
 */

export const VISION_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const

export type VisionMediaType = (typeof VISION_MEDIA_TYPES)[number]

/** The Anthropic API caps base64 image sources at 5 MB of raw bytes. */
export const MAX_VISION_IMAGE_BYTES = 5 * 1024 * 1024

/** Model-readable media type for a mime, or null when vision cannot read it. */
export function visionMediaType(mime: string | null | undefined): VisionMediaType | null {
  if (!mime) return null
  const normalized = normalizeMime(mime)
  return (VISION_MEDIA_TYPES as readonly string[]).includes(normalized)
    ? (normalized as VisionMediaType)
    : null
}

export type VisionImageInput = { mediaType: VisionMediaType; base64: string }

/**
 * Build the image payload for an uploaded document, or explain why not.
 * Pure — the caller supplies bytes and mime, no IO here.
 */
export function visionImageFor(
  buf: Buffer,
  mime: string | null | undefined,
): { image: VisionImageInput; reason: null } | { image: null; reason: string | null } {
  const normalized = mime ? normalizeMime(mime) : ''
  if (!normalized.startsWith('image/')) return { image: null, reason: null }

  const mediaType = visionMediaType(normalized)
  if (!mediaType) {
    return {
      image: null,
      reason: `Vision OCR cannot read ${normalized} images (supported: JPEG, PNG, WebP, GIF).`,
    }
  }
  if (buf.length > MAX_VISION_IMAGE_BYTES) {
    const mb = (buf.length / 1024 / 1024).toFixed(1)
    return {
      image: null,
      reason: `Vision OCR skipped this image: ${mb} MB exceeds the 5 MB model limit.`,
    }
  }
  return { image: { mediaType, base64: buf.toString('base64') }, reason: null }
}
