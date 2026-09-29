import type { CaseDocTile } from '@/lib/daily-desk-case-types'
import { profileDownloads } from './document-download'

/** Quick look, then Upload, then one download for every stored file on the tile. */
export function DocumentTileActions({
  tile,
  busy,
  canUpload,
  onLook,
  onUpload,
}: {
  tile: Pick<CaseDocTile, 'key' | 'documentId' | 'fileUrl' | 'files'>
  busy: boolean
  canUpload: boolean
  onLook: () => void
  onUpload: () => void
}) {
  const downloads = profileDownloads(tile)
  return (
    <div className="doc-acts">
      <button className="lookbtn" onClick={onLook}>Quick look</button>
      <button className="lookbtn" disabled={busy || !canUpload} onClick={onUpload}>Upload</button>
      {downloads.length
        ? downloads.map((item) => (
            <a key={item.id} className="lookbtn" href={item.href}>
              {downloads.length > 1 ? `Download v${item.version}` : 'Download'}
            </a>
          ))
        : <button className="lookbtn" type="button" disabled>Download</button>}
    </div>
  )
}
