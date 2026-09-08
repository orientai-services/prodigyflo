import { describe, expect, it } from 'vitest'
import { countUpText, sparkGeometry } from './spark'

describe('sparkGeometry', () => {
  it('returns empty paths when fewer than two finite points exist', () => {
    expect(sparkGeometry([])).toEqual({ line: '', area: '' })
    expect(sparkGeometry([5])).toEqual({ line: '', area: '' })
    expect(sparkGeometry([NaN, Infinity, 3])).toEqual({ line: '', area: '' })
  })

  it('spans the padded box from left to right', () => {
    const { line } = sparkGeometry([0, 10], 100, 32, 2)
    expect(line.startsWith('M2 ')).toBe(true)
    expect(line).toContain('L98 ')
  })

  it('puts the max at the top and the min at the bottom of the padded box', () => {
    const { line } = sparkGeometry([0, 10], 100, 32, 2)
    // min=0 → y = 30 (bottom pad), max=10 → y = 2 (top pad)
    expect(line).toBe('M2 30L98 2')
  })

  it('draws a midline for a flat series', () => {
    const { line } = sparkGeometry([4, 4, 4], 100, 32, 2)
    expect(line).toBe('M2 16L50 16L98 16')
  })

  it('closes the area path to the baseline', () => {
    const { area } = sparkGeometry([0, 10], 100, 32, 2)
    expect(area.endsWith('L98 32L2 32Z')).toBe(true)
  })

  it('ignores non-finite values instead of corrupting the path', () => {
    const clean = sparkGeometry([1, 2, 3])
    const dirty = sparkGeometry([1, NaN, 2, Infinity, 3])
    expect(dirty).toEqual(clean)
  })
})

describe('countUpText', () => {
  it('returns the final text at progress 1 (and beyond)', () => {
    expect(countUpText('$1.2M', 1)).toBe('$1.2M')
    expect(countUpText('$1.2M', 2)).toBe('$1.2M')
  })

  it('keeps currency/suffix/separator characters intact mid-animation', () => {
    const halfway = countUpText('$1,234', 0.5)
    expect(halfway).toMatch(/^\$\d,\d{3}$/)
  })

  it('pads digit runs so the string width never changes', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 0.99]) {
      expect(countUpText('12,345 deals', t)).toHaveLength('12,345 deals'.length)
    }
  })

  it('rounds each digit run toward the target', () => {
    expect(countUpText('100', 0.5)).toBe('050')
    expect(countUpText('100', 0)).toBe('000')
  })

  it('passes non-numeric values straight through', () => {
    expect(countUpText('—', 0.3)).toBe('—')
    expect(countUpText('n/a', 0.7)).toBe('n/a')
  })

  it('clamps negative progress to zero', () => {
    expect(countUpText('42', -1)).toBe('00')
  })
})
