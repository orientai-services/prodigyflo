import { describe, expect, it } from 'vitest'
import { MAX_VISION_IMAGE_BYTES, visionImageFor, visionMediaType } from './vision'

describe('visionMediaType', () => {
  it('accepts the model-readable image types', () => {
    expect(visionMediaType('image/jpeg')).toBe('image/jpeg')
    expect(visionMediaType('image/png')).toBe('image/png')
    expect(visionMediaType('image/webp')).toBe('image/webp')
    expect(visionMediaType('image/gif')).toBe('image/gif')
  })

  it('normalizes aliases before matching', () => {
    expect(visionMediaType('image/jpg')).toBe('image/jpeg')
    expect(visionMediaType('IMAGE/JPEG; charset=binary')).toBe('image/jpeg')
  })

  it('rejects HEIC and non-image types', () => {
    expect(visionMediaType('image/heic')).toBeNull()
    expect(visionMediaType('image/heif')).toBeNull()
    expect(visionMediaType('application/pdf')).toBeNull()
    expect(visionMediaType('text/plain')).toBeNull()
    expect(visionMediaType(null)).toBeNull()
    expect(visionMediaType(undefined)).toBeNull()
  })
})

describe('visionImageFor', () => {
  const bytes = Buffer.from('fake-image-bytes')

  it('returns nothing for non-images (text/PDF keep the text pipeline)', () => {
    expect(visionImageFor(bytes, 'application/pdf')).toEqual({ image: null, reason: null })
    expect(visionImageFor(bytes, 'text/plain')).toEqual({ image: null, reason: null })
    expect(visionImageFor(bytes, null)).toEqual({ image: null, reason: null })
  })

  it('builds a base64 payload for a readable image', () => {
    const result = visionImageFor(bytes, 'image/png')
    expect(result.reason).toBeNull()
    expect(result.image).toEqual({ mediaType: 'image/png', base64: bytes.toString('base64') })
  })

  it('routes jpg alias to image/jpeg', () => {
    expect(visionImageFor(bytes, 'image/jpg').image?.mediaType).toBe('image/jpeg')
  })

  it('explains why an unsupported image format is not read', () => {
    const result = visionImageFor(bytes, 'image/heic')
    expect(result.image).toBeNull()
    expect(result.reason).toContain('image/heic')
  })

  it('explains why an oversized image is not read', () => {
    const big = Buffer.alloc(MAX_VISION_IMAGE_BYTES + 1)
    const result = visionImageFor(big, 'image/jpeg')
    expect(result.image).toBeNull()
    expect(result.reason).toContain('5 MB')
  })
})
