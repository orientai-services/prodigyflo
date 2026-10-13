import { describe, expect, it } from 'vitest'
import { squareCrop } from './avatar-crop'

describe('squareCrop', () => {
  it('cuts the centered square of a landscape or portrait photo', () => {
    expect(squareCrop(4000, 3000)).toEqual({ sx: 500, sy: 0, side: 3000, out: 512 })
    expect(squareCrop(1080, 1920)).toEqual({ sx: 0, sy: 420, side: 1080, out: 512 })
  })
  it('never upscales a small picture', () => {
    expect(squareCrop(200, 300)).toEqual({ sx: 0, sy: 50, side: 200, out: 200 })
  })
  it('refuses an empty or broken size', () => {
    expect(squareCrop(0, 10)).toBeNull()
    expect(squareCrop(Number.NaN, 10)).toBeNull()
  })
})
