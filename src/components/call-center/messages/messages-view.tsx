'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import type { MessageVM, ThreadSummaryVM, ThreadVM } from '@/lib/call-center/messages'
import { markMessagesRead, sendMessagesText } from '@/lib/call-center/messages-actions'
import { MAX_TEXT_LENGTH, clockLabel, messagesHref, threadMatches, withDaySeparators } from '@/lib/call-center/messages-core'
import { phoneText } from '@/lib/call-center/phone-display'
import { LeadPhone } from '../lead-phone'
import { useEdgeSwipeBack } from '../native/use-native-shell'
import './messages.css'

/** A phone's edge swipe presses the pane's own ‹ back (the innermost visible one: a thread's before its conversation's). */
function pressBack(pane: HTMLElement | null, selector: string) {
  const buttons = Array.from(pane?.querySelectorAll<HTMLElement>(selector) ?? []).filter((el) => el.offsetParent !== null)
  buttons.at(-1)?.click()
}

type Props = {
  base: string
  threads: ThreadSummaryVM[]
  thread: ThreadVM | null
  /** A `?t=` that isn't in the actor's list. */
  missing: boolean
  initialQuery: string
  nowIso: string
}

function initials(name: string): string {
  if (name.startsWith('•') || !/[A-Za-z]/.test(name)) return '#'
  const parts = name.split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

export function MessagesView({ base, threads, thread, missing, initialQuery, nowIso }: Props) {
  const [query, setQuery] = useState(initialQuery)
  // A phone's open thread is a pushed screen: swipe from the left edge to go back.
  const paneRef = useRef<HTMLDivElement>(null)
  useEdgeSwipeBack(paneRef, Boolean(thread || missing), () => pressBack(paneRef.current, '.msg-back'))
  const shown = useMemo(() => threads.filter((t) => threadMatches(t, query)), [threads, query])
  const openKey = thread?.key ?? null

  return (
    <section className={`msg${thread || missing ? ' msg-has-thread' : ''}`} aria-label="Messages">
      <div className="msg-list-pane">
        <label className="msg-search">
          <span className="sr">Search messages</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name or last 4"
            aria-label="Search messages by name or last 4"
            autoComplete="off"
            enterKeyHint="search"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        {threads.length === 0 ? (
          <p className="msg-empty">No texts yet. When a lead or client texts your number, the conversation shows up here.</p>
        ) : shown.length === 0 ? (
          <p className="msg-empty">Nothing matches “{query.trim()}”.</p>
        ) : (
          <ul className="msg-threads">
            {shown.map((t) => (
              <li key={t.key}>
                <Link prefetch={false}
                  href={messagesHref(base, { t: t.key, q: query.trim() || null })}
                  className={`msg-row${t.key === openKey ? ' on' : ''}${t.unread > 0 && t.key !== openKey ? ' unread' : ''}`}
                  aria-current={t.key === openKey ? 'page' : undefined}
                  scroll={false}
                >
                  <span className={`msg-avatar msg-avatar-${t.kind}`} aria-hidden="true">{initials(t.name)}</span>
                  <span className="msg-row-main">
                    <b>{t.name}</b>
                    <span className="msg-snippet">
                      {t.lastDirection === 'out' ? 'You: ' : ''}
                      {t.snippet || 'Text'}
                    </span>
                  </span>
                  <span className="msg-row-side">
                    <time dateTime={t.at}>{t.timeLabel}</time>
                    {t.unread > 0 && t.key !== openKey ? (
                      <span className="msg-dot" aria-label={`${t.unread} unread`}>{t.unread > 9 ? '9+' : t.unread}</span>
                    ) : t.kind === 'client' ? (
                      <span className="msg-kind">Client</span>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div ref={paneRef} className="msg-thread-pane">
        {thread ? (
          <ThreadView
            key={thread.key}
            base={base}
            query={query}
            thread={thread}
            hadUnread={(threads.find((t) => t.key === thread.key)?.unread ?? 0) > 0}
            nowIso={nowIso}
          />
        ) : missing ? (
          <div className="msg-thread msg-gone">
            <div className="msg-head">
              <Link prefetch={false} className="msg-back" href={messagesHref(base, { t: null })} aria-label="Back to messages">‹</Link>
              <div className="msg-who"><b>Conversation not found</b></div>
            </div>
            <p className="msg-empty">This conversation isn&apos;t in your list.</p>
          </div>
        ) : (
          <p className="msg-pick">Pick a conversation to read it and reply.</p>
        )}
      </div>
    </section>
  )
}

type LocalMessage = MessageVM & { local?: boolean }

function ThreadView({
  base,
  query,
  thread,
  hadUnread,
  nowIso,
}: {
  base: string
  query: string
  thread: ThreadVM
  hadUnread: boolean
  nowIso: string
}) {
  const router = useRouter()
  const [extra, setExtra] = useState<LocalMessage[]>([])
  const [text, setText] = useState('')
  const [pending, startTransition] = useTransition()
  const endRef = useRef<HTMLDivElement>(null)

  // The server's copy wins once it carries a message we added locally.
  const messages = useMemo(() => {
    const ids = new Set(thread.messages.map((m) => m.id))
    return [...thread.messages, ...extra.filter((m) => !ids.has(m.id))]
  }, [thread.messages, extra])
  const rows = useMemo(() => withDaySeparators(messages, new Date(nowIso)), [messages, nowIso])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  // Opening a thread marks its inbound texts read; refresh so the dot and badge clear.
  useEffect(() => {
    if (!hadUnread) return
    let live = true
    void markMessagesRead(thread.key).then((res) => {
      if (live && res.changed > 0) router.refresh()
    })
    return () => {
      live = false
    }
  }, [thread.key, hadUnread, router])

  function send() {
    const body = text.trim()
    if (!body || pending) return
    startTransition(async () => {
      const res = await sendMessagesText(thread.key, body)
      if (res.ok) {
        setExtra((prev) => [...prev, res.message])
        setText('')
        router.refresh()
      } else {
        // Nothing went out: the bubble says why, and the words stay in the box to fix or retry.
        const at = new Date()
        setExtra((prev) => [
          ...prev,
          {
            id: `local-${at.getTime()}`,
            direction: 'out',
            text: body,
            at: at.toISOString(),
            time: clockLabel(at),
            status: 'failed',
            note: res.error,
            by: null,
            local: true,
          },
        ])
      }
    })
  }

  return (
    <div className="msg-thread">
      <div className="msg-head">
        <Link prefetch={false} className="msg-back" href={messagesHref(base, { t: null, q: query.trim() || null })} aria-label="Back to messages" scroll={false}>
          ‹
        </Link>
        <div className="msg-who">
          <b>{thread.name}</b>
          <span>
            {thread.kind === 'client' ? 'Client' : 'Lead'}
            {thread.phone ? (
              phoneText(thread.phone, null) !== thread.name ? <> · <LeadPhone phone={thread.phone} last4={thread.last4} /></> : null
            ) : thread.last4 && !thread.name.includes(thread.last4) ? ` · •••-•••-${thread.last4}` : ''}
          </span>
        </div>
        <Link prefetch={false} className="msg-open" href={thread.openHref}>
          Open {thread.kind === 'client' ? 'client' : 'lead'}
        </Link>
      </div>
      <div className="msg-scroll" role="log" aria-live="polite" aria-label={`Texts with ${thread.name}`}>
        {rows.length === 0 ? <p className="msg-empty">No texts yet. Say hello below.</p> : null}
        {rows.map((row) =>
          row.kind === 'day' ? (
            <div key={`d-${row.key}`} className="msg-day">
              <span>{row.label}</span>
            </div>
          ) : (
            <Bubble key={row.message.id} message={row.message} />
          ),
        )}
        <div ref={endRef} />
      </div>
      {thread.canSend ? (
        <form
          className="msg-compose"
          onSubmit={(event) => {
            event.preventDefault()
            send()
          }}
        >
          <label className="msg-input">
            <span className="sr">Text message</span>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  send()
                }
              }}
              rows={1}
              maxLength={MAX_TEXT_LENGTH}
              autoCapitalize="sentences"
              placeholder="Write a text"
            />
          </label>
          <button type="submit" className="msg-send" disabled={pending || !text.trim()}>
            {pending ? 'Sending…' : 'Send'}
          </button>
        </form>
      ) : (
        <p className="msg-compose msg-compose-off">{thread.sendNote}</p>
      )}
    </div>
  )
}

function statusWord(m: MessageVM): string | null {
  if (m.direction === 'in') return null
  switch (m.status) {
    case 'sending': return 'Sending'
    case 'delivered': return 'Delivered'
    case 'sent': return 'Sent'
    default: return null
  }
}

function Bubble({ message: m }: { message: LocalMessage }) {
  const word = statusWord(m)
  return (
    <div className={`msg-bubble-row ${m.direction}`}>
      <div className={`msg-bubble ${m.direction}${m.status === 'failed' ? ' failed' : ''}`}>
        <p>{m.text}</p>
      </div>
      <small className="msg-meta">
        {m.by ? `${m.by} · ` : ''}
        <time dateTime={m.at}>{m.time}</time>
        {word ? ` · ${word}` : ''}
      </small>
      {m.status === 'failed' && m.note ? (
        <small className="msg-fail" role={m.local ? 'alert' : 'note'}>
          {m.note}
        </small>
      ) : null}
    </div>
  )
}
