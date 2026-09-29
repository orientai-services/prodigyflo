import { NextResponse } from 'next/server'
import { ingestForm } from '@/lib/call-center/store'

/**
 * Later: Meta leadgen webhook. Today: locked unless CALL_CENTER_INGEST_KEY is set.
 * Does not create an SCS intake client.
 */
export async function POST(request: Request) {
  const key = process.env.CALL_CENTER_INGEST_KEY
  if (!key) {
    return NextResponse.json(
      { error: 'Ingest locked. Set CALL_CENTER_INGEST_KEY on this branch before plugging Facebook forms.' },
      { status: 423 },
    )
  }
  const sent = request.headers.get('x-call-center-ingest-key')
  if (sent !== key) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const payload = await request.json().catch(() => ({}))
  const result = ingestForm(payload)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json({ lead: result.lead })
}
