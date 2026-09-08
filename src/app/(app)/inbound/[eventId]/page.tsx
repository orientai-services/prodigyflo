import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, ArrowUpRight, Settings2, UserX } from 'lucide-react'
import type { Prisma } from '@prisma/client'
import { requirePermissionPage } from '@/lib/rbac'
import { PageHeader } from '@/components/page-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { dateTime, relativeTime } from '@/lib/format'
import { getInboundEvent } from '@/lib/inbound/queries'
import { CategoryPill, ConnectorChip } from '../pills'

export const metadata = { title: 'Inbound event' }

/** Flatten a normalized JSON object to display rows; skip empties. */
function normalizedRows(value: Prisma.JsonValue): { key: string; value: string }[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const out: { key: string; value: string }[] = []
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null || v === undefined || v === '') continue
    out.push({ key: k, value: typeof v === 'object' ? JSON.stringify(v) : String(v) })
  }
  return out
}

export default async function InboundEventPage({ params }: PageProps<'/inbound/[eventId]'>) {
  const user = await requirePermissionPage('connectors:read')
  const { eventId } = await params
  const event = await getInboundEvent(user, eventId)
  if (!event) notFound()

  const rows = normalizedRows(event.normalized)
  const rawJson = JSON.stringify(event.rawPayload, null, 2)

  return (
    <>
      <PageHeader title={event.summary} description={`Received ${dateTime(event.occurredAt)} · ${relativeTime(event.occurredAt)}`}>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <CategoryPill category={event.category} />
          <span className="text-muted-foreground font-mono text-xs">{event.eventType}</span>
          <ConnectorChip glyph={event.connector.glyph} name={event.connector.name} accent={event.connector.accent} />
        </div>
        <div className="mt-3">
          <Link href="/inbound" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm">
            <ArrowLeft className="size-3.5" />
            Back to inbound
          </Link>
        </div>
      </PageHeader>

      <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Normalized fields</CardTitle>
            </CardHeader>
            <CardContent>
              {rows.length === 0 ? (
                <p className="text-muted-foreground text-sm">No normalized fields were recorded for this event.</p>
              ) : (
                <div className="scroll-x">
                  <table className="w-full min-w-[32rem] text-sm">
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.key} className="border-b last:border-0">
                          <td className="text-muted-foreground w-1/3 py-1.5 pr-4 align-top font-mono text-xs">{r.key}</td>
                          <td className="py-1.5 align-top break-words">{r.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Raw payload</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="scroll-x bg-surface-sunk/60 max-h-[28rem] overflow-auto rounded-md border">
                <pre className="p-3 font-mono text-xs leading-relaxed">{rawJson}</pre>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Linked client</CardTitle>
            </CardHeader>
            <CardContent>
              {event.clientName ? (
                <Link
                  href={`/clients/${event.clientId}`}
                  className="hover:bg-muted/50 -m-1 flex items-center justify-between rounded-md p-1"
                >
                  <span className="font-medium">{event.clientName}</span>
                  <ArrowUpRight className="text-muted-foreground size-4" />
                </Link>
              ) : event.clientHidden ? (
                <p className="text-muted-foreground text-sm">
                  This event is matched to a client outside your access scope.
                </p>
              ) : (
                <div className="space-y-3">
                  <div className="text-muted-foreground flex items-center gap-2 text-sm">
                    <UserX className="size-4" />
                    Unmatched — no client link
                  </div>
                  <p className="text-muted-foreground text-xs">
                    The intake pipeline couldn&apos;t match this payload to an existing client by email or
                    phone. Check the connector&apos;s field mapping and dedupe keys.
                  </p>
                  <Link
                    href={`/settings/intake/${event.connector.sourceId}`}
                    className="hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium"
                  >
                    <Settings2 className="size-3.5" />
                    Open connector mapping
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                <Detail label="Category" value={<CategoryPill category={event.category} />} />
                <Detail label="Event type" value={<span className="font-mono text-xs">{event.eventType}</span>} />
                <Detail label="Connector" value={event.connector.name} />
                <Detail
                  label="External id"
                  value={<span className="font-mono text-xs break-all">{event.externalId}</span>}
                />
                {event.submissionId && (
                  <Detail label="Submission" value={<span className="font-mono text-xs">{event.submissionId}</span>} />
                )}
                <Detail label="Occurred" value={dateTime(event.occurredAt)} />
                <Detail label="Recorded" value={dateTime(event.createdAt)} />
              </dl>
            </CardContent>
          </Card>

          {!event.clientName && !event.clientHidden && (
            <Alert>
              <AlertTitle>Why is this unmatched?</AlertTitle>
              <AlertDescription>
                Unmatched events still arrive and are stored — they just aren&apos;t tied to a client
                record. Fix the mapping and future events will link automatically.
              </AlertDescription>
            </Alert>
          )}
        </div>
      </div>
    </>
  )
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-muted-foreground shrink-0">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  )
}
