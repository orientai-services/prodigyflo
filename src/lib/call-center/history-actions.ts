'use server'

import { requireUser } from '@/lib/rbac'
import { loadActivity, loadHistory } from './history'
import { isHistoryFilter, type ActivityPage, type HistoryPage } from './history-format'

/** "Load more" on Calls & SMS: the next 50 after `cursor`, same filter and search. */
export async function loadMoreHistory(filter: string, q: string, cursor: string): Promise<HistoryPage> {
  const user = await requireUser()
  return loadHistory(user, {
    filter: isHistoryFilter(filter) ? filter : 'all',
    q: typeof q === 'string' ? q.slice(0, 60) : '',
    cursor: typeof cursor === 'string' ? cursor : null,
  })
}

/** "Load more" on Activity. */
export async function loadMoreActivity(cursor: string): Promise<ActivityPage> {
  const user = await requireUser()
  return loadActivity(user, { cursor: typeof cursor === 'string' ? cursor : null })
}
