import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/rbac'

export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ notifications: [] }, { status: 401 })

  const notifications = await db.notification.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 15,
  })
  return NextResponse.json({ notifications })
}

export async function POST() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ ok: false }, { status: 401 })

  await db.notification.updateMany({
    where: { userId: user.id, readAt: null },
    data: { readAt: new Date() },
  })
  return NextResponse.json({ ok: true })
}
