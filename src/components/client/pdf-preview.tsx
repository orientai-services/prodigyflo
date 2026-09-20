'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

type PdfDocument = Awaited<ReturnType<typeof import('unpdf').getDocumentProxy>>

/** Render the authenticated original without depending on a browser PDF plug-in. */
export function PdfPreview({ url, title }: { url: string; title: string }) {
  const [document, setDocument] = useState<PdfDocument | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [rendering, setRendering] = useState(true)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let disposed = false
    let opened: PdfDocument | undefined
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
        if (!response.ok) throw new Error(response.status === 403 ? 'This document link has expired. Close Quick view and reload the profile.' : `Document could not be opened (${response.status}).`)
        const bytes = new Uint8Array(await response.arrayBuffer())
        const { getDocumentProxy } = await import('unpdf')
        opened = await getDocumentProxy(bytes)
        if (disposed) { await opened.loadingTask.destroy(); return }
        setDocument(opened)
      } catch (cause) {
        if (!disposed) { setError(cause instanceof Error ? cause.message : 'PDF preview could not be loaded.'); setRendering(false) }
      }
    })()
    return () => { disposed = true; controller.abort(); void opened?.loadingTask.destroy() }
  }, [url])

  useEffect(() => {
    if (!document) return
    let disposed = false
    let cancel: (() => void) | undefined
    void (async () => {
      try {
        setRendering(true)
        const page = await document.getPage(pageNumber)
        if (disposed || !canvasRef.current) return
        const canvas = canvasRef.current
        const viewport = page.getViewport({ scale: 1.5 })
        canvas.width = viewport.width
        canvas.height = viewport.height
        const context = canvas.getContext('2d')
        if (!context) throw new Error('This browser cannot render the document. Use Open original or Download.')
        const task = page.render({ canvas, canvasContext: context, viewport })
        cancel = () => task.cancel()
        await task.promise
        if (!disposed) setRendering(false)
      } catch (cause) {
        if (!disposed) { setError(cause instanceof Error ? cause.message : 'PDF page could not be rendered.'); setRendering(false) }
      }
    })()
    return () => { disposed = true; cancel?.() }
  }, [document, pageNumber])

  return (
    <div>
      {document && <div className="flex items-center justify-between gap-3 pb-3">
        <Button variant="outline" size="sm" disabled={pageNumber === 1} onClick={() => setPageNumber(pageNumber - 1)}>Previous page</Button>
        <span aria-live="polite">Page {pageNumber} of {document.numPages}</span>
        <Button variant="outline" size="sm" disabled={pageNumber === document.numPages} onClick={() => setPageNumber(pageNumber + 1)}>Next page</Button>
      </div>}
      {error ? <p role="alert">{error} You can also use Open original or Download above.</p> : <>
        {rendering && <p role="status">Loading document page…</p>}
        <canvas ref={canvasRef} role="img" aria-label={`${title}, page ${pageNumber}`} style={{ width: '100%', height: 'auto', display: rendering ? 'none' : 'block' }} />
      </>}
    </div>
  )
}
