import { canAny, getSessionUser } from '@/lib/rbac'
import { db } from '@/lib/db'
import { saveTemplateAction } from '@/app/(app)/settings/templates/actions'

/** Lists the organization's message templates. */
export async function GET(request: Request) {
  const user = await getSessionUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canAny(user, ['communications:send', 'connectors:read'])) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const sp = new URL(request.url).searchParams
  const channel = sp.get('channel')
  const activeOnly = sp.get('active') !== 'false'

  const templates = await db.messageTemplate.findMany({
    where: {
      organizationId: user.organizationId,
      ...(activeOnly ? { isActive: true } : {}),
      ...(channel === 'EMAIL' || channel === 'SMS' ? { channel } : { channel: { in: ['EMAIL', 'SMS'] } }),
    },
    orderBy: [{ name: 'asc' }, { locale: 'asc' }],
    select: {
      id: true,
      key: true,
      name: true,
      channel: true,
      locale: true,
      subject: true,
      body: true,
      isActive: true,
      updatedAt: true,
    },
  })

  return Response.json({ templates })
}

/** Creates or updates a template. Same validation and audit path as the settings UI. */
export async function POST(request: Request) {
  const raw = await request.json().catch(() => null)
  if (!raw) return Response.json({ error: 'Invalid JSON body' }, { status: 400 })

  const result = await saveTemplateAction(raw)
  if (!result.ok) {
    const status = result.errors._form?.includes('permission') ? 403 : 422
    return Response.json({ errors: result.errors }, { status })
  }
  return Response.json({ id: result.id }, { status: 201 })
}
