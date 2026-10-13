import { readFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { BRANDED_SLUGS, brandFor } from '@/components/brand/org-brand'
import { APP_CHROME, APP_PAPER, splashFor, splashImages } from '@/lib/pwa/app-chrome'

/**
 * iOS startup images: `/splash/<brand>/<w>x<h>-<light|dark>.png`.
 *
 * Rendered from the brand's own icon at BUILD time (every combination is in
 * generateStaticParams, nothing renders on request), so the repo carries one
 * icon per brand instead of ~80 full-screen PNGs. The picture is the paper
 * (or, in dark mode, the navy) with the app icon centred, which is what the
 * first frame of the app looks like before the page paints.
 */
export const dynamicParams = false

export function generateStaticParams() {
  return BRANDED_SLUGS.flatMap((brand) => splashImages().map((s) => ({ brand, file: s.file })))
}

/** The icon tile, in points: about the size of a home-screen icon held up close. */
const TILE_PT = 112

export async function GET(_req: Request, ctx: RouteContext<'/splash/[brand]/[file]'>) {
  const { brand: slug, file } = await ctx.params
  const splash = splashFor(file)
  if (!splash || !BRANDED_SLUGS.includes(slug)) return new Response('Not found', { status: 404 })

  const brand = brandFor(slug)
  const tile = TILE_PT * splash.dpr
  const radius = Math.round(tile * 0.225)
  const icon = await readFile(path.join(process.cwd(), 'public', 'brand', brand.iconDir, 'icon-maskable-512.png'))
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tile}" height="${tile}"><rect width="${tile}" height="${tile}" rx="${radius}" fill="#fff"/></svg>`)
  const rounded = await sharp(icon)
    .resize(tile, tile, { kernel: 'lanczos3' })
    .ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer()

  const png = await sharp({
    create: {
      width: splash.width,
      height: splash.height,
      channels: 3,
      background: splash.theme === 'dark' ? APP_CHROME : APP_PAPER,
    },
  })
    .composite([{ input: rounded, left: Math.round((splash.width - tile) / 2), top: Math.round((splash.height - tile) / 2) }])
    .png({ compressionLevel: 9, palette: true })
    .toBuffer()

  return new Response(new Uint8Array(png), {
    headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800' },
  })
}
