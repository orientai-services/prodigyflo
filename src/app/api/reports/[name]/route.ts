import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { getSessionUser } from '@/lib/rbac'

/**
 * Serves the generated project-report pages (built by `npm run reports`) to
 * signed-in staff. The files are standalone HTML documents rendered inside an
 * iframe on /settings/progress — they are project-internal (schema layout,
 * row counts, roadmap caveats), hence the auth gate.
 */

const REPORTS: Record<string, string> = {
  roadmap: 'roadmap.html',
  'schema-map': 'schema-map.html',
}

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const user = await getSessionUser()
  if (!user) return new Response('Unauthorized', { status: 401 })
  if (user.role === 'CLIENT') return new Response('Forbidden', { status: 403 })

  const { name } = await ctx.params
  const file = REPORTS[name]
  if (!file) return new Response('Not found', { status: 404 })

  const abs = path.join(process.cwd(), 'reports', 'out', file)
  try {
    const [html, info] = await Promise.all([readFile(abs, 'utf8'), stat(abs)])
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Last-Modified': info.mtime.toUTCString(),
        'Cache-Control': 'private, no-cache',
        // Same-origin frames only — these pages are meant for /settings/progress.
        'X-Frame-Options': 'SAMEORIGIN',
      },
    })
  } catch {
    return new Response(
      'Report not built yet. Run `npm run reports` in the project root.',
      { status: 404, headers: { 'Content-Type': 'text/plain' } },
    )
  }
}
