import { finalDeskEnabled } from '@/lib/final-desk/data'
import { FinalDeskPage } from '@/components/final-desk/page'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/rbac'
import { canReadDesk, loadDeskBoard } from '@/lib/daily-desk-data'
import { shiftMonth } from '@/lib/daily-desk'
import { DeskCalendar } from './desk-calendar'

export const metadata = { title: 'Board' }

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if (finalDeskEnabled()) return <FinalDeskPage view="board" />
  const user = await requireUser()
  if (!canReadDesk(user)) redirect('/forbidden')

  const params = await searchParams
  const month = typeof params.month === 'string' ? params.month : undefined
  const board = await loadDeskBoard(user, month)
  const prev = shiftMonth(board.month, -1)
  const next = shiftMonth(board.month, 1)

  return (
    <DeskCalendar
      board={board}
      prevHref={`/board?month=${prev}`}
      nextHref={`/board?month=${next}`}
      todayHref="/board"
    />
  )
}
