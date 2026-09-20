import { notFound, redirect } from 'next/navigation'
import { requireUser } from '@/lib/rbac'
import { loadFinalDesk } from '@/lib/final-desk/data'
import type { DeskView } from '@/lib/final-desk/types'
import { FinalDesk } from './final-desk'

export async function FinalDeskPage({ view, clientId, month }: { view: DeskView; clientId?: string; month?: string }) {
  const user = await requireUser()
  if (['engine', 'users'].includes(view) && user.role !== 'SUPER_ADMIN') redirect('/forbidden')
  let initial
  try { initial = await loadFinalDesk(user, view, clientId, month) }
  catch (error) { if (error instanceof Error && error.message === 'Not found') notFound(); throw error }
  return <FinalDesk key={`${view}:${clientId ?? ''}`} view={view} clientId={clientId} initial={initial} />
}
