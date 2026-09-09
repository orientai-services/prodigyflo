import { assemblePacket } from '@/lib/packet/data'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PacketCopy } from './packet-copy'
import { PacketGate } from './packet-gate'

export async function PacketPanel({ clientId }: { clientId: string }) {
  const packet = await assemblePacket(clientId)
  if (!packet) return null

  const blocked = packet.closeability === 'C'
  const strawberryOpen = packet.floor.strawberryMayRun

  return (
    <Card>
      <CardHeader>
        <CardTitle>Close packet</CardTitle>
        <p className="text-muted-foreground text-sm">
          packet_status={packet.packet_status} · closeability={packet.closeability} · strawberry_status=
          {packet.strawberry_status}
        </p>
        <p className="text-muted-foreground text-sm">
          {packet.fileId} · {packet.pathLabel} · {packet.trenchLabel} · auditor=grok-floor-manager
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <PacketGate
          clientId={clientId}
          floorStampedReady={packet.floor.floorStampedReady}
          closerApproved={packet.closerApproved}
          holdReason={packet.floor.holdReason}
        />
        <section>
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-xs font-semibold tracking-wide uppercase">
              Floor-manager audit packet — closer brief
            </h3>
            <PacketCopy label="Copy close talk" text={packet.closerWin.closeTalk} />
          </div>
          <pre className="bg-muted overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">{packet.brief}</pre>
        </section>
        <section>
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-xs font-semibold tracking-wide uppercase">Dashboard payload (closer only)</h3>
            {!blocked && <PacketCopy label="Copy payload" text={packet.payload} />}
          </div>
          <pre className="bg-muted overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">{packet.payload}</pre>
        </section>
        <section>
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-xs font-semibold tracking-wide uppercase">Strawberry skill</h3>
            {strawberryOpen && <PacketCopy label="Copy skill" text={packet.skill} />}
          </div>
          <pre className="bg-muted overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">{packet.skill}</pre>
        </section>
      </CardContent>
    </Card>
  )
}
