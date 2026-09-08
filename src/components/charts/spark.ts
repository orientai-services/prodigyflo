/**
 * Pure geometry + text helpers behind the StatTile sparkline and count-up.
 * Kept free of React/DOM so they unit-test in node.
 */

export type SparkGeometry = {
  /** SVG path for the stroked line ("" when there are not two finite points). */
  line: string
  /** SVG path for the soft area under the line, closed to the baseline. */
  area: string
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Maps a value series onto an SVG path pair inside a width×height box.
 * A flat series draws a midline, so "no movement" still reads as a line.
 */
export function sparkGeometry(
  values: number[],
  width = 100,
  height = 32,
  pad = 2,
): SparkGeometry {
  const pts = values.filter((v) => Number.isFinite(v))
  if (pts.length < 2) return { line: '', area: '' }

  const min = Math.min(...pts)
  const max = Math.max(...pts)
  const span = max - min
  const innerW = width - pad * 2
  const innerH = height - pad * 2

  const coords = pts.map((v, i) => {
    const x = pad + (i / (pts.length - 1)) * innerW
    // Flat series → midline; otherwise higher values sit higher (smaller y).
    const y = span === 0 ? height / 2 : pad + (1 - (v - min) / span) * innerH
    return { x: round2(x), y: round2(y) }
  })

  const line = coords.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join('')
  const first = coords[0]
  const last = coords[coords.length - 1]
  const area = `${line}L${last.x} ${height}L${first.x} ${height}Z`
  return { line, area }
}

/**
 * Interpolates every digit run in a formatted value toward its final reading,
 * padding with leading zeros so the string never changes width mid-animation.
 * Non-numeric text ("—", "$", "%", separators) passes through untouched.
 */
export function countUpText(finalText: string, progress: number): string {
  const t = Math.min(1, Math.max(0, progress))
  if (t >= 1) return finalText
  return finalText.replace(/\d+/g, (run) => {
    // Digit runs longer than 15 chars would lose integer precision — leave them.
    if (run.length > 15) return run
    const target = Number(run)
    const current = Math.round(target * t)
    return String(current).padStart(run.length, '0')
  })
}
