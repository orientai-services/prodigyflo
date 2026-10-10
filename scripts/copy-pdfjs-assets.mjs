// Serve the installed pdfjs-dist worker + decoder assets from /pdfjs so the
// browser Quick look uses one matching PDF.js build (API, worker, wasm, fonts).
import { cpSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = dirname(require.resolve('pdfjs-dist/package.json'))
const out = join(process.cwd(), 'public', 'pdfjs')
mkdirSync(out, { recursive: true })
for (const dir of ['wasm', 'standard_fonts', 'cmaps', 'iccs']) {
  const src = join(root, dir)
  if (existsSync(src)) cpSync(src, join(out, dir), { recursive: true })
}
cpSync(join(root, 'build', 'pdf.worker.min.mjs'), join(out, 'pdf.worker.min.mjs'))
console.log(`pdfjs assets copied to ${out}`)
