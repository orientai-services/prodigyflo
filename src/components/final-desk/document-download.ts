import type { CaseDocTile } from '@/lib/daily-desk-case-types'

/** Same-origin file route only. Adds the attachment flag the file route already honors. */
export function downloadHref(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const next = new URL(url, 'https://prodigyflo.local')
    if (!next.pathname.startsWith('/api/documents/') || !next.pathname.endsWith('/file')) return null
    next.searchParams.set('download', '1')
    return `${next.pathname}?${next.searchParams.toString()}`
  } catch {
    return null
  }
}

export type ProfileDownload = { id: string; href: string; version: number }

/** Every stored file on a profile tile, in the tile's own order, without duplicates. */
export function profileDownloads(tile: Pick<CaseDocTile, 'key' | 'documentId' | 'fileUrl' | 'files'>): ProfileDownload[] {
  const candidates = [
    ...tile.files.map((file) => ({ id: file.id, url: file.fileUrl, version: file.version })),
    { id: tile.documentId ?? tile.key, url: tile.fileUrl, version: tile.files[0]?.version ?? 1 },
  ]
  const seen = new Set<string>()
  const rows: ProfileDownload[] = []
  for (const candidate of candidates) {
    const href = downloadHref(candidate.url)
    if (!href || seen.has(href)) continue
    seen.add(href)
    rows.push({ id: candidate.id, href, version: candidate.version })
  }
  return rows
}
