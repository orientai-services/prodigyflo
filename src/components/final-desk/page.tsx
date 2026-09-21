import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { requireUser } from '@/lib/rbac'
import { loadFinalDesk } from '@/lib/final-desk/data'
import type { DeskView } from '@/lib/final-desk/types'
import { InvalidFilterError, type ClientQuery } from '@/lib/final-desk/filters'
import { FinalDesk } from './final-desk'

export async function FinalDeskPage({ view, clientId, month, query }: { view: DeskView; clientId?: string; month?: string; query?: ClientQuery }) {
  const user = await requireUser()
  if (['engine', 'users'].includes(view) && user.role !== 'SUPER_ADMIN') redirect('/forbidden')
  let initial
  try { initial = await loadFinalDesk(user, view, clientId, month, query) }
  catch (error) { if(error instanceof InvalidFilterError) return <div role="alert" style={{padding:32}}>Invalid client filter: {error.message} <Link href="/clients">Clear filters</Link></div>; if (error instanceof Error && error.message === 'Not found') notFound(); throw error }
  return <FinalDesk key={`${view}:${clientId ?? ''}:${JSON.stringify(query??{})}`} view={view} clientId={clientId} initial={initial} query={query} />
}
