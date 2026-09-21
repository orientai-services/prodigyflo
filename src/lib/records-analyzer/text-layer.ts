/**
 * Is the text in this PDF the document, or the container it came in?
 *
 * On 2026-09-10, 81 of 102 production extraction calls returned nothing, $3.03
 * spent, because every gate between a PDF and the model measured HOW MUCH text
 * a file carried and never WHAT the text was. A scan printed to PDF from a
 * browser carries ~249 characters per page of the browser's own print chrome —
 * a timestamp, the filename, a signed URL and `1/2` — which cleared a
 * 120-chars-per-page floor by 2× and a 200-character absolute floor outright.
 * The file was declared a text-layer document, the bytes were never sent, and
 * the model was handed a URL and asked for the interest rate. It answered
 * correctly: nothing. See docs/EXTRACTION-FINDING-2026-09-10.md.
 *
 * Length cannot fix this. Measured against the real production files, a header
 * page is 248–251 characters while a genuine cover page of a 22-page purchase
 * agreement is 221 and a DocuSign trailer page is 170. The ranges overlap. What
 * does not overlap is what is left once the chrome is removed: 0 characters on
 * every header page, at least 170 on every real one.
 *
 * So this module strips the chrome and judges the residue, one page at a time.
 * It lives in `lib/` rather than beside `pdf.ts` for the same reason
 * `extraction-yield.ts` does: `pdf.ts` imports `server-only`, and
 * `check:text-layer` has to test the real rule rather than a copy of it. Two
 * copies of a gate drifting apart is exactly how the two gates this replaces
 * ended up at 120 and 200.
 *
 * The stripping is ONLY for judging. The text handed to the model is the page
 * as extracted — a contract may legitimately quote a URL or a date, and a
 * judged-clean page loses nothing by keeping its header.
 */

/**
 * What a browser writes on a page it prints. Each pattern is one piece of the
 * verbatim production header:
 *
 *   9/10/26, 2:39 AM  53f5614e-…-Scan_20260814_16_.jpg (1700×2338)
 *   https://…supabase.co/storage/v1/object/sign/documents/…  1/2
 *
 * A pattern that matched real contract prose would strip content and push a
 * genuine page toward "unreadable" — the safe direction, since vision still
 * reads it. A pattern that missed a piece of chrome leaves a few characters,
 * which is why the floor below is not zero.
 */
const PRINT_CHROME: RegExp[] = [
  // 9/10/26, 2:39 AM · 10/09/2026 14:39 · 9/10/26 2:39:07 PM
  /\b\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?\b/gi,
  // any URL — a signed storage URL is the longest single piece of the header
  /https?:\/\/\S+/gi,
  // the filename the browser put in the title bar
  /\S+\.(?:jpe?g|png|webp|gif|heic|heif|tiff?|bmp|pdf)\b/gi,
  // the image dimensions a browser appends to an image tab's title
  /\(\s*\d{2,5}\s*[×x]\s*\d{2,5}\s*\)/gi,
  // the `1/2` page counter in the footer
  /\b\d{1,4}\s*\/\s*\d{1,4}\b/g,
];

/**
 * Below this many characters of residue a page has no text worth reading. The
 * real minimum observed is 170 (a DocuSign trailer); the real maximum for a
 * header page is 0. Forty sits well inside the gap on both sides and still
 * tolerates a stray token or two of chrome the patterns did not catch.
 */
export const MIN_RESIDUE_CHARS_PER_PAGE = 40;

/**
 * The share of a document's pages allowed to carry no readable text before the
 * whole file is sent as images instead.
 *
 * A text-layer document is read from its text alone — the bytes are never
 * sent. Every page whose text is missing is a page the model is not shown. A
 * blank page costs nothing to omit; a scanned page inside an otherwise digital
 * file is the document going missing, and the two are indistinguishable
 * without rendering. So the rule is conservative: a fifth of the pages
 * unreadable and the model sees all of them. A two-page file must be clean on
 * both pages; a 22-page contract may carry four.
 */
export const MAX_UNREADABLE_PAGE_SHARE = 0.2;

/** The page text with browser print chrome removed and whitespace collapsed. */
export function stripPrintChrome(pageText: string): string {
  let t = pageText;
  for (const re of PRINT_CHROME) t = t.replace(re, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

/** Does this one page carry text that is the document rather than the container? */
export function pageHasText(pageText: string): boolean {
  return stripPrintChrome(pageText).length >= MIN_RESIDUE_CHARS_PER_PAGE;
}

/**
 * A NUL in extracted page text is binary contamination, not a document.
 * One such page is enough: the file is read as images (vision), not text.
 * Persist of that string is `UTF8 0x00`; the file bytes are the document.
 */
export function nulForcesVision(pages: readonly string[]): boolean {
  return pages.some((p) => p.includes('\0'));
}

/**
 * Postgres `text` rejects 0x00. A PDF file coerced to a string starts `%PDF`.
 * Persist markdown through this so that column never holds either.
 */
export function utf8Markdown(value: string | null | undefined): string | null {
  if (value == null || value.length === 0) return null;
  if (value.startsWith('%PDF')) return null;
  const cleaned = value.replace(/\0/g, '');
  return cleaned.length > 0 ? cleaned : null;
}

export interface TextLayerVerdict {
  /** True when the file can be read from its text alone. */
  hasTextLayer: boolean;
  pageCount: number;
  /** Pages that carry real text after the chrome is stripped. */
  textPages: number;
  /** 1-based page numbers that carry no readable text. */
  unreadablePages: number[];
}

/**
 * One verdict per file, from one judgement per page.
 *
 * `pages` is the extracted text of each page in order — `extractText(pdf,
 * { mergePages: false })`. An empty array (a file with no pages, or one that
 * could not be parsed) has no text layer.
 */
export function judgeTextLayer(pages: readonly string[]): TextLayerVerdict {
  const pageCount = pages.length;
  const unreadablePages: number[] = [];
  pages.forEach((text, i) => {
    if (!pageHasText(text)) unreadablePages.push(i + 1);
  });
  const textPages = pageCount - unreadablePages.length;
  const allowed = Math.floor(pageCount * MAX_UNREADABLE_PAGE_SHARE);
  return {
    hasTextLayer: pageCount > 0 && textPages > 0 && unreadablePages.length <= allowed,
    pageCount,
    textPages,
    unreadablePages,
  };
}
