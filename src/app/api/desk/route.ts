import { InvalidFilterError } from '@/lib/final-desk/filters'
import { z } from 'zod'
import { getSessionUser } from '@/lib/rbac'
import { finalDeskEnabled, loadFinalDesk } from '@/lib/final-desk/data'

export async function GET(request: Request) {
  const user = await getSessionUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  if (!finalDeskEnabled()) return Response.json({ error: 'Not found' }, { status: 404 })
  const url = new URL(request.url)
  const parsed = z.enum(['board', 'clients', 'profile', 'questionnaire', 'queue', 'engine', 'documents', 'submissions', 'users']).safeParse(url.searchParams.get('view'))
  if (!parsed.success) return Response.json({ error: 'Invalid view' }, { status: 400 })
  if (['engine', 'users'].includes(parsed.data) && user.role !== 'SUPER_ADMIN') return Response.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const data = await loadFinalDesk(user, parsed.data, url.searchParams.get('clientId') ?? undefined, url.searchParams.get('month') ?? undefined, Object.fromEntries(['filters','scheduling','page'].flatMap(k=>url.searchParams.has(k)?[[k,url.searchParams.get(k)!]]:[])))
    return Response.json(data, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof InvalidFilterError) return Response.json({ error: error.message }, { status: 400 })
    if (error instanceof Error && error.message === 'Not found') return Response.json({ error: 'Not found' }, { status: 404 })
    console.error('[final-desk] load failed', error instanceof Error ? error.name : 'error')
    return Response.json({ error: 'Unable to load this view' }, { status: 500 })
  }
}
