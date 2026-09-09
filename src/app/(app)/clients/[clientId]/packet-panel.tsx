import { assemblePacket } from '@/lib/packet/data'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export async function PacketPanel({ clientId }: { clientId: string }) {
  const packet = await assemblePacket(clientId)
  if (!packet) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Close packet</CardTitle>
        <p className="text-muted-foreground text-sm">
          {packet.fileId} · {packet.ready.closeability} · {packet.pathLabel} · {packet.trenchLabel} ·
          Strawberry {packet.strawberry}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm">
          {packet.ready.ready
            ? 'READY — paste the payload, run the skill, human Submit.'
            : `Not READY (${packet.ready.missing.join(', ') || 'gaps'}). Do not Dashboard.`}
        </p>
        <section>
          <h3 className="mb-1 text-xs font-semibold tracking-wide uppercase">Closer brief</h3>
          <pre className="bg-muted overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">{packet.brief}</pre>
        </section>
        <section>
          <h3 className="mb-1 text-xs font-semibold tracking-wide uppercase">Dashboard payload</h3>
          <pre className="bg-muted overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">{packet.payload}</pre>
        </section>
        <section>
          <h3 className="mb-1 text-xs font-semibold tracking-wide uppercase">Strawberry skill</h3>
          <pre className="bg-muted overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">{packet.skill}</pre>
        </section>
      </CardContent>
    </Card>
  )
}
