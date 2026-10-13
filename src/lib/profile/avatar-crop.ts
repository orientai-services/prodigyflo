/**
 * The centered square a profile photo is cut to before upload: the largest
 * square in the middle of the picture, drawn at most `max` px on a side
 * (never upscaled). Pure, so the sheet's canvas step is tested here.
 */
export const AVATAR_CROP_PX = 512

export type SquareCrop = { sx: number; sy: number; side: number; out: number }

export function squareCrop(width: number, height: number, max = AVATAR_CROP_PX): SquareCrop | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null
  const side = Math.floor(Math.min(width, height))
  return {
    sx: Math.floor((width - side) / 2),
    sy: Math.floor((height - side) / 2),
    side,
    out: Math.min(side, max),
  }
}
