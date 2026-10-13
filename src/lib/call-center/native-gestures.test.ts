import { describe, expect, it } from 'vitest'
import {
  EDGE_PX,
  PULL_MAX,
  edgeSwipeGoesBack,
  edgeSwipeIsHorizontal,
  edgeSwipeStarts,
  pullDistance,
  pullTriggers,
  sheetOffset,
  sheetShouldClose,
} from './native-gestures'

describe('sheet drag', () => {
  it('closes past a third of its height or on a flick, never on a nudge', () => {
    expect(sheetShouldClose(10, 5, 500)).toBe(false)
    expect(sheetShouldClose(100, 0.1, 500)).toBe(false)
    expect(sheetShouldClose(160, 0.1, 500)).toBe(true)
    expect(sheetShouldClose(40, 0.9, 500)).toBe(true)
    // A short sheet still needs 80 px.
    expect(sheetShouldClose(60, 0.1, 150)).toBe(false)
    expect(sheetShouldClose(-50, 2, 500)).toBe(false)
  })
  it('follows down 1:1 and resists up', () => {
    expect(sheetOffset(42)).toBe(42)
    expect(sheetOffset(-400)).toBe(-24)
    expect(sheetOffset(-4)).toBe(-4)
  })
})

describe('edge swipe', () => {
  it('starts only at the left edge', () => {
    expect(edgeSwipeStarts(5)).toBe(true)
    expect(edgeSwipeStarts(EDGE_PX)).toBe(true)
    expect(edgeSwipeStarts(EDGE_PX + 1)).toBe(false)
  })
  it('owns only a mostly horizontal move', () => {
    expect(edgeSwipeIsHorizontal(30, 5)).toBe(true)
    expect(edgeSwipeIsHorizontal(20, 40)).toBe(false)
    expect(edgeSwipeIsHorizontal(6, 0)).toBe(false)
  })
  it('goes back past 35% of the width or on a flick', () => {
    expect(edgeSwipeGoesBack(150, 0.1, 390)).toBe(true)
    expect(edgeSwipeGoesBack(100, 0.1, 390)).toBe(false)
    expect(edgeSwipeGoesBack(60, 0.8, 390)).toBe(true)
    expect(edgeSwipeGoesBack(30, 3, 390)).toBe(false)
  })
})

describe('pull to refresh', () => {
  it('damps the pull and caps it', () => {
    expect(pullDistance(-20)).toBe(0)
    expect(pullDistance(100)).toBe(50)
    expect(pullDistance(1000)).toBe(PULL_MAX)
  })
  it('refreshes past the trigger only', () => {
    expect(pullTriggers(100)).toBe(false)
    expect(pullTriggers(140)).toBe(true)
  })
})
