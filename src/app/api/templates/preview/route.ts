import { db } from '@/lib/db'
import { canAny, findClientInScope, getSessionUser } from '@/lib/rbac'
import { dateTime, humanize } from '@/lib/format'
import { baseVarsForClient, renderTemplate, type TemplateVars } from '@/lib/messaging/render'

/**
 * Renders one template against one real client — used by the settings preview
 * and available to the composer. Context variables (appointment, document) are
 * auto-resolved from the client's next appointment and oldest outstanding
 * document so the preview matches what a reminder send would produce.
 */
export async function GET(request: Request) {
  const user = await getSessionUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canAny(user, ['communications:send', 'connectors:manage'])) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const sp = new URL(request.url).searchParams
  const templateId = sp.get('templateId')
  const clientId = sp.get('clientId')
  if (!templateId || !clientId) {
    return Response.json({ error: 'templateId and clientId are required' }, { status: 422 })
  }

  const [template, client] = await Promise.all([
    db.messageTemplate.findFirst({ where: { id: templateId, organizationId: user.organizationId } }),
    findClientInScope(user, clientId, {
      owner: { select: { name: true } },
      organization: { select: { name: true } },
    }),
  ])
  if (!template) return Response.json({ error: 'Template not found' }, { status: 404 })
  if (!client) return Response.json({ error: 'Client not found or out of scope' }, { status: 404 })

  const [appointment, document] = await Promise.all([
    db.appointment.findFirst({
      where: { clientId: client.id, status: { in: ['SCHEDULED', 'CONFIRMED'] }, startsAt: { gt: new Date() } },
      orderBy: { startsAt: 'asc' },
      select: { startsAt: true, timezone: true, type: true, location: true },
    }),
    db.clientDocument.findFirst({
      where: { clientId: client.id, status: { in: ['REQUESTED', 'MISSING_INFORMATION'] } },
      orderBy: { requestedAt: 'asc' },
      select: { label: true, fileName: true, requirement: { select: { name: true } } },
    }),
  ])

  const vars: TemplateVars = {
    ...baseVarsForClient(client as never),
    ...(appointment
      ? {
          appointment_date: dateTime(appointment.startsAt, appointment.timezone),
          appointment_type: humanize(appointment.type),
          appointment_location: appointment.location ?? '',
        }
      : {}),
    ...(document
      ? { document_name: document.requirement?.name ?? document.label ?? document.fileName ?? '' }
      : {}),
  }

  return Response.json(renderTemplate({ subject: template.subject, body: template.body }, vars))
}
