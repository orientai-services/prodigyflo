import { describe, expect, it } from 'vitest'
import {
  AVATAR_MAX_BYTES,
  avatarKeyFromUrl,
  avatarPublicPath,
  avatarStorageKey,
  parseAvatarFileParam,
  validateAvatarUpload,
} from './avatar'

/** Minimal real magic-byte prefixes, padded so the text-sniff never triggers. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64)])
const PDF = Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(64)])
const HEIC = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(64)])

const UID = 'clxyz1234567890abcdefg'

describe('validateAvatarUpload', () => {
  it.each([
    [JPEG, 'image/jpeg', 'jpg'],
    [PNG, 'image/png', 'png'],
    [WEBP, 'image/webp', 'webp'],
  ] as const)('accepts %#: sniffed %s → ext %s', (buf, mime, ext) => {
    const result = validateAvatarUpload(buf, mime)
    expect(result).toEqual({ ok: true, mimeType: mime, ext })
  })

  it('accepts a missing declared type by deferring to the sniff', () => {
    expect(validateAvatarUpload(PNG, '')).toEqual({ ok: true, mimeType: 'image/png', ext: 'png' })
  })

  it('normalizes declared aliases (image/jpg → image/jpeg)', () => {
    expect(validateAvatarUpload(JPEG, 'image/jpg')).toMatchObject({ ok: true, mimeType: 'image/jpeg' })
  })

  it('rejects the empty file', () => {
    expect(validateAvatarUpload(Buffer.alloc(0), 'image/png').ok).toBe(false)
  })

  it('rejects over the 2MB cap', () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(AVATAR_MAX_BYTES)])
    const result = validateAvatarUpload(big, 'image/jpeg')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('2 MB')
  })

  it('rejects non-image content even with an image declared type', () => {
    expect(validateAvatarUpload(PDF, 'image/png').ok).toBe(false)
  })

  it('rejects document-allowed types that avatars do not take (HEIC, text)', () => {
    expect(validateAvatarUpload(HEIC, 'image/heic').ok).toBe(false)
    expect(validateAvatarUpload(Buffer.from('hello world, plainly text'), 'text/plain').ok).toBe(false)
  })

  it('rejects a rename trick: real PNG declared as JPEG', () => {
    const result = validateAvatarUpload(PNG, 'image/jpeg')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('image/png')
  })
})

describe('avatar key / path derivation', () => {
  it('builds the deterministic per-user key', () => {
    expect(avatarStorageKey(UID, 'jpg')).toBe(`avatars/${UID}.jpg`)
  })

  it('throws on hostile ids and unknown extensions', () => {
    expect(() => avatarStorageKey('../etc/passwd', 'jpg')).toThrow()
    expect(() => avatarStorageKey('short', 'jpg')).toThrow()
    expect(() => avatarStorageKey(UID.toUpperCase(), 'jpg')).toThrow()
    expect(() => avatarStorageKey(UID, 'svg')).toThrow()
    expect(() => avatarStorageKey(UID, 'jpg/..')).toThrow()
  })

  it('public path embeds id, ext, and cache-buster', () => {
    expect(avatarPublicPath(UID, 'webp', 42)).toBe(`/api/profile/avatar/${UID}.webp?v=42`)
  })

  it('parseAvatarFileParam round-trips the served segment', () => {
    expect(parseAvatarFileParam(`${UID}.png`)).toEqual({ userId: UID, ext: 'png' })
    expect(parseAvatarFileParam(`${UID}.PNG`)).toEqual({ userId: UID, ext: 'png' })
  })

  it.each(['', 'no-extension', '.jpg', `${UID}.svg`, `${UID}.jpg.png`, '..%2f..%2fx.jpg', 'UPPER1234567890.jpg'])(
    'parseAvatarFileParam rejects %j',
    (bad) => {
      expect(parseAvatarFileParam(bad)).toBeNull()
    },
  )

  it('avatarKeyFromUrl derives the key back from a stored avatarUrl', () => {
    const url = avatarPublicPath(UID, 'jpg', Date.now())
    expect(avatarKeyFromUrl(url)).toBe(`avatars/${UID}.jpg`)
  })

  it('avatarKeyFromUrl returns null for absent or foreign urls', () => {
    expect(avatarKeyFromUrl(null)).toBeNull()
    expect(avatarKeyFromUrl(undefined)).toBeNull()
    expect(avatarKeyFromUrl('')).toBeNull()
    expect(avatarKeyFromUrl('https://evil.example/x.jpg')).toBeNull()
    expect(avatarKeyFromUrl('/api/documents/abc/file')).toBeNull()
    expect(avatarKeyFromUrl('/api/profile/avatar/../../x.jpg')).toBeNull()
  })
})
