import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/rbac'
import { applyAction, getLead } from '@/lib/call-center/store'

const MESSAGES = {
  call: 'Mock call only. Twilio stays unplugged until you approve the desk.',
  sms: 'Mock text only. A2P / Twilio SMS stays unplugged.',
  book: 'Callback booked on this Call Center lead. Still not intake.',
  missed: 'Marked missed on the Call Center list.',
} as const

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await context.params
  const lead = getLead(id)
  if (!lead) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ lead })
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await context.params
  const body = (await request.json().catch(() => ({}))) as { action?: string }
  const action = body.action
  if (action !== 'call' && action !== 'sms' && action !== 'book' && action !== 'missed') {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  }
  const lead = applyAction(id, action)
  if (!lead) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ lead, message: MESSAGES[action] })
}
