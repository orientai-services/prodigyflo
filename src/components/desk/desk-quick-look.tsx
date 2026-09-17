'use client'

import { Dialog, DialogContent } from '@/components/ui/dialog'

export type DeskLookFile = {
  id: string
  label: string
  clientName?: string
  fileUrl: string | null
  mimeType: string | null
}

/** Same Quick look shell as the case-file document grid. Missing file = not on file. */
export function DeskQuickLook({
  look,
  onClose,
}: {
  look: DeskLookFile | null
  onClose: () => void
}) {
  return (
    <Dialog open={look !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="desk desk-lookbox flex h-[92vh] w-[96vw] max-w-[96vw] flex-col gap-3 p-4 sm:max-w-[96vw]"
        showCloseButton={false}
      >
        {look && (
          <>
            <div className="desk-lookhead shrink-0">
              <div>
                <div
                  className="desk-muted"
                  style={{ fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase' }}
                >
                  Quick look
                </div>
                <h3>{look.label}</h3>
                {look.clientName ? <div className="desk-muted">{look.clientName}</div> : null}
              </div>
              <button type="button" className="desk-btn-secondary" onClick={onClose}>
                Close
              </button>
            </div>
            {look.fileUrl ? (
              <div className="desk-paper min-h-0 flex-1">
                {look.mimeType?.startsWith('image/') ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={look.fileUrl} alt={look.label} style={{ maxHeight: '100%', width: '100%', objectFit: 'contain' }} />
                ) : (
                  <iframe title={look.label} src={look.fileUrl} style={{ width: '100%', height: '100%', minHeight: '78vh', border: 0 }} />
                )}
              </div>
            ) : (
              <div className="desk-empty-look">
                <div className="desk-v miss" style={{ fontSize: 20 }}>
                  Not on file
                </div>
                <p className="desk-muted">This document is not uploaded yet. No preview is invented.</p>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
