import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/rbac'
import { getFileStorage } from '@/lib/storage'
import { AVATAR_EXT_TO_MIME, avatarStorageKey, parseAvatarFileParam } from '@/lib/profile/avatar'

/**
 * Serves one user's avatar (`/api/profile/avatar/<userId>.<ext>?v=N`) to
 * signed-in viewers inside the same organization tree.
 *
 * The gate: any staff user whose ACTIVE organization shares a root with the
 * avatar owner's organization (same org, agency ↔ its child accounts, or two
 * siblings under one agency — the tree is one level deep, so "root" is just
 * `parentOrganizationId ?? id`, two indexed point reads). Portal CLIENT users
 * may fetch only their own. Never public: an avatar URL leaked outside the
 * tenant returns 404, indistinguishable from a user that does not exist.
 *
 * Caching is private with an mtime/size ETag: the storage key is stable
 * across replaces, so the validator — plus the `v` cache-buster the app puts
 * on stored URLs — is what keeps a stale photo from sticking.
 */

export async function GET(request: Request, ctx: RouteContext<'/api/profile/avatar/[file]'>) {
  const viewer = await getSessionUser()
  if (!viewer) return new Response('Unauthorized', { status: 401 })

  const { file } = await ctx.params
  const parsed = parseAvatarFileParam(file)
  if (!parsed) return new Response('Not found', { status: 404 })

  const target = await db.user.findFirst({
    where: { id: parsed.userId, deletedAt: null },
    select: {
      id: true,
      avatarUrl: true,
      organizationId: true,
      organization: { select: { parentOrganizationId: true } },
    },
  })
  // Only the CURRENT avatar is served — a stale key left on disk or a probed
  // extension mismatch is a 404, not a leak of replaced photos.
  if (!target || !target.avatarUrl?.startsWith(`/api/profile/avatar/${parsed.userId}.${parsed.ext}`)) {
    return new Response('Not found', { status: 404 })
  }

  if (viewer.id !== target.id) {
    // Portal clients see exactly one avatar: their own.
    if (viewer.role === 'CLIENT') return new Response('Not found', { status: 404 })

    const targetRoot = target.organization.parentOrganizationId ?? target.organizationId
    let viewerRoot = viewer.organizationId
    if (viewer.organizationId !== target.organizationId) {
      const viewerOrg = await db.organization.findUnique({
        where: { id: viewer.organizationId },
        select: { parentOrganizationId: true },
      })
      viewerRoot = viewerOrg?.parentOrganizationId ?? viewer.organizationId
    }
    if (viewer.organizationId !== target.organizationId && viewerRoot !== targetRoot) {
      return new Response('Not found', { status: 404 })
    }
  }

  const storage = getFileStorage()
  const key = avatarStorageKey(parsed.userId, parsed.ext)
  const meta = await storage.stat(key)
  if (!meta) return new Response('Not found', { status: 404 })

  const etag = `"${Math.trunc(meta.mtimeMs)}-${meta.size}"`
  const headers = {
    'Content-Type': AVATAR_EXT_TO_MIME[parsed.ext],
    'Cache-Control': 'private, max-age=86400',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
  }

  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers })
  }

  const buf = await storage.get(key).catch(() => null)
  if (!buf) return new Response('Not found', { status: 404 })

  return new Response(new Uint8Array(buf), {
    headers: { ...headers, 'Content-Length': String(buf.length) },
  })
}
