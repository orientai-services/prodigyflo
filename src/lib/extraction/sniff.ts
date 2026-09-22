import { createHash } from 'node:crypto'

/**
 * Upload validation primitives. The declared Content-Type is attacker-controlled,
 * so acceptance is decided by magic-byte sniffing — the declared type only has to
 * agree with what the bytes actually are.
 */

export const DEFAULT_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
  'text/plain',
]

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'heif', 'mif1', 'msf1'])

/** Identify a buffer by its leading bytes. Returns null when unrecognized. */
export function sniffMimeType(buf: Buffer): string | null {
  const head = buf.subarray(0, Math.min(buf.length, 8192)).toString('latin1')
  if (head.includes('%PDF-') || head.includes('%PDF')) return 'application/pdf'
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf'
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1').toLowerCase()
    if (HEIC_BRANDS.has(brand)) return 'image/heic'
  }

  // Plain text: no NUL bytes and overwhelmingly printable in the first 1KB.
  const sample = buf.subarray(0, 1024)
  if (sample.length > 0) {
    let printable = 0
    for (const byte of sample) {
      if (byte === 0) return null
      if (byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte < 0xf5)) printable++
    }
    if (printable / sample.length > 0.97) return 'text/plain'
  }
  return null
}

/** Normalize aliases so a comparison never fails on spelling. */
export function normalizeMime(mime: string): string {
  const m = mime.trim().toLowerCase().split(';')[0]
  if (m === 'image/jpg' || m === 'image/pjpeg') return 'image/jpeg'
  if (m === 'application/x-pdf') return 'application/pdf'
  if (m === 'image/heif') return 'image/heic'
  if (m === 'message/rfc822') return 'text/plain'
  if (m.startsWith('text/')) return 'text/plain'
  return m
}

export type UploadValidation =
  | { ok: true; mimeType: string }
  | { ok: false; reason: string }

export function validateUpload(input: {
  buffer: Buffer
  declaredMime: string
  maxSizeMb: number
  allowedMimeTypes: string[]
}): UploadValidation {
  const { buffer, maxSizeMb } = input
  if (buffer.length === 0) return { ok: false, reason: 'The file is empty.' }

  const maxBytes = maxSizeMb * 1024 * 1024
  if (buffer.length > maxBytes) {
    const mb = (buffer.length / 1024 / 1024).toFixed(1)
    return { ok: false, reason: `The file is ${mb} MB — the limit for this document is ${maxSizeMb} MB.` }
  }

  const allowed = (input.allowedMimeTypes.length ? input.allowedMimeTypes : DEFAULT_ALLOWED_MIME_TYPES).map(normalizeMime)
  const sniffed = sniffMimeType(buffer)
  if (!sniffed) {
    return { ok: false, reason: 'Unrecognized file content. Accepted formats: PDF, JPEG, PNG, HEIC, WebP, or plain text.' }
  }
  if (!allowed.includes(sniffed)) {
    return { ok: false, reason: `${sniffed} files are not accepted for this document. Accepted: ${allowed.join(', ')}.` }
  }

  const declared = normalizeMime(input.declaredMime || sniffed)
  if (declared !== sniffed) {
    return {
      ok: false,
      reason: `The file's content (${sniffed}) does not match its declared type (${declared}). Rename tricks are rejected.`,
    }
  }
  return { ok: true, mimeType: sniffed }
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}
