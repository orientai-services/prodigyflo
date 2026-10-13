// Generates the installed app's small raster assets (docs/MOBILE.md "Installed app").
//
//   node scripts/pwa-assets.mjs
//
// Output (committed, so the build does not depend on this script):
//   public/brand/<dir>/apple-touch-icon-152.png, -167.png  iPad home-screen icons, from each brand's 180 px icon
//   public/pwa/shortcut-<id>.png                          192 px manifest shortcut icons (long-press menu)
//
// Startup (splash) images are NOT here: there are dozens of them, so src/app/splash/[brand]/[file]/route.ts
// renders them from the brand icon at build time instead of committing megabytes of PNGs.
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const require = createRequire(import.meta.url)
const { createElement } = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { Sun, Grid3x3, MessageSquare, Users } = require('lucide-react')

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pub = (...p) => path.join(root, 'public', ...p)

for (const dir of ['prodigyflo', 'scs']) {
  for (const size of [152, 167]) {
    await sharp(pub('brand', dir, 'apple-touch-icon.png'))
      .resize(size, size, { kernel: 'lanczos3' })
      .flatten({ background: '#ffffff' })
      .png({ compressionLevel: 9 })
      .toFile(pub('brand', dir, `apple-touch-icon-${size}.png`))
  }
}

// Desk navy tile + white glyph: the same language as the Call Center tab bar.
const SHORTCUTS = { today: Sun, dialer: Grid3x3, messages: MessageSquare, leads: Users }
await mkdir(pub('pwa'), { recursive: true })
for (const [id, Icon] of Object.entries(SHORTCUTS)) {
  const glyph = renderToStaticMarkup(createElement(Icon, { size: 96, color: '#ffffff', strokeWidth: 2 }))
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192">
  <rect width="192" height="192" rx="42" fill="#12202c"/>
  <g transform="translate(48 48)">${glyph}</g>
</svg>`
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(pub('pwa', `shortcut-${id}.png`))
}
console.log('pwa assets written')
