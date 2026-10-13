/**
 * The lead panel's Comms trail can stack dozens of call recordings. It shows
 * the newest RECORDINGS_SHOWN of them (and every event after the oldest one
 * shown); "Show more" reveals RECORDINGS_STEP more at a time.
 *
 * The trail is oldest first, so the hidden part is always the top.
 */
export const RECORDINGS_SHOWN = 3
export const RECORDINGS_STEP = 10

export type TrailWindow = {
  /** Index of the first trail event on screen. */
  start: number
  /** Recordings above `start`, still hidden. */
  hiddenRecordings: number
}

export function trailWindow(trail: readonly { recording?: unknown }[], shown: number): TrailWindow {
  let seen = 0
  for (let index = trail.length - 1; index >= 0; index -= 1) {
    if (!trail[index].recording) continue
    seen += 1
    if (seen > shown) {
      const total = trail.filter((event) => event.recording).length
      return { start: index + 1, hiddenRecordings: total - shown }
    }
  }
  return { start: 0, hiddenRecordings: 0 }
}
