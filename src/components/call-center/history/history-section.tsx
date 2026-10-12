import Link from 'next/link'
import type { JSX } from 'react'
import { Search } from 'lucide-react'
import type { SessionUser } from '@/lib/rbac'
import { missingRelation } from '@/lib/call-center/desk'
import { loadActivity, loadHistory } from '@/lib/call-center/history'
import {
  HISTORY_FILTERS,
  baseFields,
  historyHref,
  parseHistoryParams,
  type ActivityPage,
  type HistoryPage,
  type HistoryState,
} from '@/lib/call-center/history-format'
import { ActivityList } from './activity-list'
import { HistoryList } from './history-list'

function emptyText(state: HistoryState): string {
  if (state.q) return `Nothing matches “${state.q}”.`
  switch (state.filter) {
    case 'calls': return 'No calls yet.'
    case 'answered': return 'No answered calls yet.'
    case 'missed': return 'No missed calls.'
    case 'sms': return 'No texts yet.'
    case 'unattached': return 'Every call is matched to a lead or a client.'
    default: return 'No calls or texts yet.'
  }
}

/**
 * The dialer's History section (docs/DIALER_APP.md §3), rendered by the shell
 * as a server slot. State lives in the URL under `ht` / `hf` / `hq`, and every
 * link is built on `base` so it stays inside the section.
 */
export async function HistorySection(props: {
  user: SessionUser
  params: Record<string, string | string[] | undefined>
  base: string
}): Promise<JSX.Element> {
  const { user, params, base } = props
  const state = parseHistoryParams(params)
  const now = new Date()

  let calls: HistoryPage = { rows: [], nextCursor: null }
  let activity: ActivityPage = { rows: [], nextCursor: null }
  try {
    if (state.tab === 'activity') activity = await loadActivity(user, {}, now)
    else calls = await loadHistory(user, { filter: state.filter, q: state.q }, now)
  } catch (err) {
    // An unmigrated database reads as an empty history, like the desk.
    if (!missingRelation(err)) throw err
  }

  const { path, fields } = baseFields(base)
  const tabs: { id: HistoryState['tab']; label: string }[] = [
    { id: 'calls', label: 'Calls & SMS' },
    { id: 'activity', label: 'Activity' },
  ]

  return (
    <section className="hist" aria-label="History">
      <nav className="hist-tabs" aria-label="History views">
        {tabs.map((t) => (
          <Link
            key={t.id}
            href={historyHref(base, { tab: t.id })}
            className={state.tab === t.id ? 'on' : undefined}
            aria-current={state.tab === t.id ? 'page' : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {state.tab === 'calls' ? (
        <>
          <form className="hist-search" action={path} method="get" role="search">
            {fields.map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
            {state.filter !== 'all' ? <input type="hidden" name="hf" value={state.filter} /> : null}
            <label className="hist-field">
              <Search size={16} aria-hidden="true" />
              <span className="sr">Search by name or last 4 digits</span>
              <input type="search" name="hq" defaultValue={state.q} placeholder="Name or last 4" autoComplete="off" maxLength={60} />
            </label>
            <button type="submit" className="btn">Search</button>
            {state.q ? (
              <Link className="hist-clear" href={historyHref(base, { filter: state.filter })}>
                Clear
              </Link>
            ) : null}
          </form>
          <nav className="hist-chips" aria-label="Filter calls and texts">
            {HISTORY_FILTERS.map((f) => (
              <Link
                key={f.id}
                href={historyHref(base, { filter: f.id, q: state.q })}
                className={state.filter === f.id ? 'on' : undefined}
                aria-current={state.filter === f.id ? 'true' : undefined}
              >
                {f.label}
              </Link>
            ))}
          </nav>
          <HistoryList
            key={`${state.filter}|${state.q}`}
            initial={calls.rows}
            nextCursor={calls.nextCursor}
            filter={state.filter}
            q={state.q}
            emptyText={emptyText(state)}
          />
        </>
      ) : (
        <ActivityList initial={activity.rows} nextCursor={activity.nextCursor} />
      )}
    </section>
  )
}
