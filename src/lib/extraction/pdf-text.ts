import { extractText, getDocumentProxy } from 'unpdf'

export type PdfText = {
  /** One entry per physical page, including blank pages. Never compact this array. */
  pages: string[]
  pageCount: number
  warnings: string[]
  needsVision: boolean
}

/** Browser print chrome is not a readable scan: judge only the document residue. */
export function hasReadablePdfText(text: string): boolean {
  const residue = text
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?\b/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\S+\.(?:jpe?g|png|webp|gif|heic|heif|tiff?|bmp|pdf)\b/gi, ' ')
    .replace(/\(\s*\d{2,5}\s*[×x]\s*\d{2,5}\s*\)/gi, ' ')
    .replace(/\b\d{1,4}\s*\/\s*\d{1,4}\b/g, ' ')
    .replace(/\s+/g, ' ').trim()
  return residue.length >= 40
}

/** Signed-form overlays can detach filled values from their labels in the text layer. */
export function hasSignedFormLayout(text: string): boolean {
  return /docu(?:sign|ment sign)\s+envelope\s*(?:id|number)|adobe\s*(?:acrobat\s*)?sign|\\(?:od|d\d+|s\d+|sign(?:ature)?\d*)\\/i.test(text)
}

/** PDF.js resolves fonts, object streams and the page tree rather than guessing from content streams. */
export async function extractPdfText(buf: Buffer): Promise<PdfText> {
  if (!buf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('The uploaded file is not a PDF.')
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined
  try {
    pdf = await getDocumentProxy(new Uint8Array(buf))
    const { text } = await extractText(pdf, { mergePages: false })
    const pages = text.map((page) => page.trim())
    if (pages.length !== pdf.numPages || pdf.numPages === 0) throw new Error('PDF page coverage could not be verified.')
    const unreadable = pages.flatMap((page, i) => hasReadablePdfText(page) ? [] : [i + 1])
    const signedForm = pages.some(hasSignedFormLayout)
    return {
      pages,
      pageCount: pdf.numPages,
      // Even one scanned insert may contain a signature or an amendment. Send
      // the original PDF to vision rather than silently omitting that page.
      needsVision: unreadable.length > 0 || signedForm,
      warnings: [
        ...(unreadable.length ? [`PDF pages ${unreadable.join(', ')} have insufficient readable text; document vision is required to inspect them.`] : []),
        ...(signedForm ? ['Signed-form layout detected; original PDF vision is required to associate filled values with their labels.'] : []),
      ],
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown PDF parsing error.'
    throw new Error(`PDF text could not be read. Check whether the file is damaged or password-protected, then upload an unlocked original. ${reason}`)
  } finally {
    await pdf?.loadingTask.destroy()
  }
}
