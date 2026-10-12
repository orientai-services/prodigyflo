import { IMG_MAX_BYTES, firstAttempt, fitsAlready, nextAttempt, recompressible, scaled } from './message-logic'

/**
 * Photos go up at ≤1.5 MB and ≤2560 px on the long side, redrawn as JPEG on a
 * canvas (white behind transparency), like the SunOff chat. GIF keeps its
 * animation and HEIC goes as is (the Worker accepts both up to 8 MB). The
 * sizing steps are pure (message-logic.ts) and tested there.
 */
export async function prepImage(file: File): Promise<{ file: File; w?: number; h?: number }> {
  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(file)
  } catch {
    return { file }
  }
  const w0 = bmp.width
  const h0 = bmp.height
  if (!recompressible(file.type) || fitsAlready(file.size, w0, h0)) {
    bmp.close?.()
    return { file, w: w0, h: h0 }
  }
  let a = firstAttempt(w0, h0)
  let blob: Blob | null = null
  let size = { w: w0, h: h0 }
  for (let i = 0; i < 8; i++) {
    size = scaled(w0, h0, a.dim)
    const cv = document.createElement('canvas')
    cv.width = size.w
    cv.height = size.h
    const cx = cv.getContext('2d')
    if (!cx) break
    cx.fillStyle = '#fff'
    cx.fillRect(0, 0, size.w, size.h)
    cx.drawImage(bmp, 0, 0, size.w, size.h)
    const q = a.q
    blob = await new Promise<Blob | null>((r) => cv.toBlob(r, 'image/jpeg', q))
    if (blob && blob.size <= IMG_MAX_BYTES) break
    a = nextAttempt(a)
  }
  bmp.close?.()
  if (!blob) return { file, w: w0, h: h0 }
  return { file: new File([blob], `${(file.name || 'image').replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg' }), w: size.w, h: size.h }
}
