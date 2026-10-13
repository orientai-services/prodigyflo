import { describe, expect, it } from 'vitest'
import { RECORDINGS_SHOWN, RECORDINGS_STEP, trailWindow } from './trail-window'

const rec = { recording: { src: 'x', seconds: 1 } }
const plain = {}

describe('trailWindow', () => {
  it('shows everything when there are three recordings or fewer', () => {
    expect(trailWindow([plain, rec, plain, rec, rec, plain], RECORDINGS_SHOWN)).toEqual({ start: 0, hiddenRecordings: 0 })
    expect(trailWindow([], RECORDINGS_SHOWN)).toEqual({ start: 0, hiddenRecordings: 0 })
    expect(trailWindow([plain, plain], RECORDINGS_SHOWN)).toEqual({ start: 0, hiddenRecordings: 0 })
  })

  it('starts right after the fourth newest recording, keeping later events', () => {
    // index:           0     1    2    3      4    5      6    7
    const trail = [plain, rec, rec, plain, rec, plain, rec, rec]
    // Newest three recordings: 7, 6, 4. The fourth newest is 2, so the window starts at 3.
    expect(trailWindow(trail, 3)).toEqual({ start: 3, hiddenRecordings: 2 })
  })

  it('reveals ten more per step until nothing is hidden', () => {
    const trail = Array.from({ length: 25 }, () => rec)
    expect(trailWindow(trail, RECORDINGS_SHOWN)).toEqual({ start: 22, hiddenRecordings: 22 })
    expect(trailWindow(trail, RECORDINGS_SHOWN + RECORDINGS_STEP)).toEqual({ start: 12, hiddenRecordings: 12 })
    expect(trailWindow(trail, RECORDINGS_SHOWN + 2 * RECORDINGS_STEP)).toEqual({ start: 2, hiddenRecordings: 2 })
    expect(trailWindow(trail, RECORDINGS_SHOWN + 3 * RECORDINGS_STEP)).toEqual({ start: 0, hiddenRecordings: 0 })
  })
})
