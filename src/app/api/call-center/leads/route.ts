import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/rbac'
import { listLeads } from '@/lib/call-center/store'

export async function GET(request: Request) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { searchParams } = new URL(request.url)
  const lang = (searchParams.get('lang') ?? 'all') as 'en' | 'es' | 'all'
  const queue = (searchParams.get('queue') ?? 'all') as 'new' | 'inbound' | 'missed' | 'booked' | 'all'
  return NextResponse.json({ leads: listLeads({ lang, queue }) })
}
