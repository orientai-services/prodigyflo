import type { CaseDocTile } from '@/lib/daily-desk-case-types'
import { profileDownloads, saveProfileDownloads } from './document-download'

/** Quick look, then Upload, then one Download for every stored file on the tile. */
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
      {downloads.length === 0 ? (
        <button className="lookbtn" type="button" disabled>Download</button>
      ) : downloads.length === 1 ? (
        <a className="lookbtn" href={downloads[0].href}>Download</a>
      ) : (
        <button className="lookbtn" type="button" onClick={() => saveProfileDownloads(downloads.map((item) => item.href))}>Download</button>
      )}
    </div>
  )
}
