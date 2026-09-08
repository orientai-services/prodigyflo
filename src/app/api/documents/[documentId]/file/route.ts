import { can, getSessionUser } from '@/lib/rbac'
import { findDocumentInScope } from '@/lib/storage/access'
import { getFileStorage } from '@/lib/storage'
import { verifyFileToken } from '@/lib/storage/sign'

/**
 * The only way a stored document leaves disk. Three independent checks, all
 * required: a signed short-lived token bound to this exact stored object, a
 * signed-in session with document read permission, and the client being inside
 * the caller's scope. A leaked URL without a session is useless; a session
 * without a fresh token is too.
 */

const INLINE_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'text/plain'])

export async function GET(request: Request, ctx: RouteContext<'/api/documents/[documentId]/file'>) {
  const { documentId } = await ctx.params

  const user = await getSessionUser()
  if (!user) return new Response('Unauthorized', { status: 401 })
  if (!can(user, 'documents:read')) return new Response('Forbidden', { status: 403 })

  const url = new URL(request.url)
  const token = url.searchParams.get('t')
  const payload = token ? verifyFileToken(token) : null
  if (!payload) return new Response('This link has expired. Reload the page to get a fresh one.', { status: 403 })

  const doc = await findDocumentInScope(user, documentId)
  if (!doc || !doc.storageKey) return new Response('Not found', { status: 404 })

  // Single-purpose: the token authorizes exactly this stored object.
  if (payload.key !== doc.storageKey) return new Response('Forbidden', { status: 403 })

  const buf = await getFileStorage()
    .get(doc.storageKey)
    .catch(() => null)
  if (!buf) return new Response('File is missing from storage.', { status: 404 })

  const mime = doc.mimeType && INLINE_TYPES.has(doc.mimeType) ? doc.mimeType : 'application/octet-stream'
  const download = url.searchParams.get('download') === '1' || mime === 'application/octet-stream'
  const safeName = (doc.fileName ?? 'document').replace(/[^\w.() -]/g, '_')

  return new Response(new Uint8Array(buf), {
    headers: {
      'Content-Type': mime,
      'Content-Length': String(buf.length),
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${safeName}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  })
}
