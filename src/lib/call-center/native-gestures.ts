/**
 * Pure maths behind the Call Center's touch gestures (docs/NATIVE_FEEL.md):
 * drag a bottom sheet down to close it, swipe from the left edge to go back
 * from a lead, and pull a list down to refresh it. No DOM here, so every
 * threshold is tested. (The keyboard's height comes from InstalledAppRuntime.)
 */

/** A drag shorter than this never closes a sheet, however fast it was. */
export const SHEET_MIN_PX = 24
/** A flick at this speed (px/ms) closes a sheet even when it moved only a little. */
export const SHEET_FLICK = 0.6
/** Dragged past this share of its height, a sheet closes on release. */
export const SHEET_SHARE = 0.3

/** A dragged-down sheet on release: close it, or spring back. */
export function sheetShouldClose(dy: number, velocity: number, height: number): boolean {
  if (!(dy > SHEET_MIN_PX)) return false
  if (velocity >= SHEET_FLICK) return true
  return dy >= Math.max(80, height * SHEET_SHARE)
}

/** How far a sheet follows the finger: 1:1 downwards, a stiff rubber band upwards. */
export function sheetOffset(dy: number): number {
  if (dy >= 0) return dy
  return -Math.min(24, Math.sqrt(-dy) * 2)
}

/** A back swipe has to start this close to the left edge (px), like iOS. */
export const EDGE_PX = 28
/** Released past this share of the screen width, the swipe goes back. */
export const EDGE_SHARE = 0.35
/** A rightward flick at this speed (px/ms) goes back from any distance past 40 px. */
export const EDGE_FLICK = 0.5

export function edgeSwipeStarts(x: number): boolean {
  return x >= 0 && x <= EDGE_PX
}

/** Mostly horizontal: the swipe owns the gesture; mostly vertical: the page scrolls. */
export function edgeSwipeIsHorizontal(dx: number, dy: number): boolean {
  return Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2
}

export function edgeSwipeGoesBack(dx: number, velocity: number, width: number): boolean {
  if (dx <= 40) return false
  return velocity >= EDGE_FLICK || dx >= width * EDGE_SHARE
}

/** Pulled past this (after resistance), a list refreshes on release. */
export const PULL_TRIGGER = 64
/** The indicator never travels further than this. */
export const PULL_MAX = 96

/** The finger's travel, damped the way iOS damps an over-scroll. */
export function pullDistance(dy: number): number {
  if (dy <= 0) return 0
  return Math.min(PULL_MAX, dy * 0.5)
}

export function pullTriggers(dy: number): boolean {
  return pullDistance(dy) >= PULL_TRIGGER
}
