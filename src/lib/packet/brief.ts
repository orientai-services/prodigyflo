export function buildPacketBrief(lines: {
  line1: string
  line2: string
  line3: string
  line4: string
  line5: string
  line6: string
  line7: string
  line8: string
}): string {
  return [
    lines.line1,
    lines.line2,
    lines.line3,
    lines.line4,
    lines.line5,
    lines.line6,
    lines.line7,
    lines.line8,
  ].join('\n')
}
