import type { ChatEvent, Lang } from './types'

/**
 * The browser side of ProdigyFlo's team chat: a native client of the SunOff
 * chat Worker (docs/CYS_BRIDGE.md §B4, owner decision D4). Same data as
 * sunoff.app and the SunOff dialer, no copy kept here.
 *
 * Sign-in: GET /api/chat/token (ProdigyFlo session) → a 12 h SSO token →
 * POST <chat>/api/session → a bearer session held in memory only. A cookie is
 * never used (Safari blocks third-party cookies). The socket authenticates
 * with a one-use ticket from POST <chat>/api/ws-ticket, because a browser
 * WebSocket can't carry an Authorization header. Files are fetched with the
 * bearer and shown as blob URLs.
 */

export class ChatError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export type TokenAnswer =
  | { ok: true; token: string; base: string; uid: string; expiresAt: number }
  | { ok: false; error: 'not_linked' | 'not_configured' | 'unauthorized' | 'forbidden' | string }

type Listener = (ev: ChatEvent) => void
type Status = 'connecting' | 'live' | 'polling' | 'offline'

export class ChatApi {
  base = ''
  private session = ''
  private expiresAt = 0
  private lang: Lang
  private listeners = new Set<Listener>()
  private statusListeners = new Set<(s: Status) => void>()
  private ws: WebSocket | null = null
  private wsTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private retries = 0
  private closed = false
  private blobs = new Map<string, Promise<string>>()
  status: Status = 'connecting'

  constructor(lang: Lang) {
    this.lang = lang
  }

  /** Trades a fresh ProdigyFlo-minted token for a chat session. Returns the token route's refusal as-is. */
  async signIn(): Promise<TokenAnswer & { me?: unknown }> {
    const res = await fetch(`/api/chat/token?lang=${this.lang}`, { cache: 'no-store', credentials: 'same-origin' })
    const tok = (await res.json().catch(() => ({ ok: false, error: 'server' }))) as TokenAnswer
    if (!tok.ok) return tok
    this.base = tok.base
    const r = await fetch(`${this.base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: tok.token }),
      credentials: 'omit',
    })
    const data = (await r.json().catch(() => null)) as { me?: unknown; session?: string; expires_at?: number; error?: string; message?: string } | null
    if (!r.ok || !data?.session) throw new ChatError(r.status, data?.error ?? 'session', data?.message ?? 'The chat could not start.')
    this.session = data.session
    this.expiresAt = Number(data.expires_at) || Date.now() + 3600_000
    return { ...tok, me: data.me }
  }

  private async ensureSession(): Promise<void> {
    if (this.session && Date.now() < this.expiresAt - 120_000) return
    const out = await this.signIn()
    if (!out.ok) throw new ChatError(401, out.error, 'Please reopen the chat.')
  }

  async req<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
    await this.ensureSession()
    const res = await fetch(this.base + path, {
      method,
      headers: { authorization: `Bearer ${this.session}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'omit',
      cache: 'no-store',
    })
    if (res.status === 401 && retry) {
      this.session = ''
      return this.req<T>(method, path, body, false)
    }
    const data = (await res.json().catch(() => null)) as (T & { error?: string; message?: string }) | null
    if (!res.ok) throw new ChatError(res.status, data?.error ?? 'server', data?.message ?? 'Something went wrong. Please try again.')
    return data as T
  }

  async upload(form: FormData): Promise<{ attachment: { id: string } }> {
    await this.ensureSession()
    const res = await fetch(this.base + '/api/upload', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.session}` },
      body: form,
      credentials: 'omit',
    })
    const data = (await res.json().catch(() => null)) as { attachment?: { id: string }; error?: string; message?: string } | null
    if (!res.ok || !data?.attachment) throw new ChatError(res.status, data?.error ?? 'upload', data?.message ?? 'The file did not upload.')
    return { attachment: data.attachment }
  }

  /** A blob: URL for a chat file (members only, checked by the Worker). Cached for the page's life. */
  fileUrl(id: string): Promise<string> {
    let p = this.blobs.get(id)
    if (!p) {
      p = (async () => {
        await this.ensureSession()
        const res = await fetch(`${this.base}/api/files/${encodeURIComponent(id)}`, {
          headers: { authorization: `Bearer ${this.session}` },
          credentials: 'omit',
        })
        if (!res.ok) throw new ChatError(res.status, 'file', 'File unavailable')
        return URL.createObjectURL(await res.blob())
      })()
      p.catch(() => this.blobs.delete(id))
      this.blobs.set(id, p)
    }
    return p
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  onStatus(fn: (s: Status) => void): () => void {
    this.statusListeners.add(fn)
    return () => this.statusListeners.delete(fn)
  }
  private setStatus(s: Status) {
    this.status = s
    for (const fn of this.statusListeners) fn(s)
  }

  send(ev: Record<string, unknown>): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(ev))
    return true
  }

  async connect(): Promise<void> {
    if (this.closed) return
    this.setStatus(this.retries ? 'polling' : 'connecting')
    try {
      const { ticket } = await this.req<{ ticket: string }>('POST', '/api/ws-ticket')
      const ws = new WebSocket(`${this.base.replace(/^http/, 'ws')}/ws?ticket=${encodeURIComponent(ticket)}`)
      this.ws = ws
      ws.onopen = () => {
        this.retries = 0
        this.setStatus('live')
        if (this.pingTimer) clearInterval(this.pingTimer)
        this.pingTimer = setInterval(() => this.send({ t: 'ping' }), 30_000)
      }
      ws.onmessage = (m) => {
        let ev: ChatEvent | null = null
        try {
          ev = JSON.parse(String(m.data)) as ChatEvent
        } catch {
          return
        }
        const all = ev.t === 'batch' ? ev.evs : [ev]
        for (const e of all) for (const fn of this.listeners) fn(e)
      }
      ws.onclose = (e) => {
        if (this.pingTimer) clearInterval(this.pingTimer)
        this.ws = null
        if (this.closed) return
        // 4401 = the session ended: sign in again before the next try.
        if (e.code === 4401) this.session = ''
        this.retry()
      }
    } catch {
      this.retry()
    }
  }

  private retry() {
    if (this.closed) return
    this.setStatus(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'polling')
    this.retries++
    const wait = Math.min(30_000, 1000 * 2 ** Math.min(this.retries, 5))
    if (this.wsTimer) clearTimeout(this.wsTimer)
    this.wsTimer = setTimeout(() => void this.connect(), wait)
  }

  /** Undo close(): React runs mount effects twice in development, on the same client. */
  reopen() {
    this.closed = false
    this.retries = 0
  }

  close() {
    this.closed = true
    if (this.wsTimer) clearTimeout(this.wsTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.ws?.close(1000)
    for (const p of this.blobs.values()) void p.then((u) => URL.revokeObjectURL(u)).catch(() => undefined)
    this.blobs.clear()
  }
}

/** Time-sortable client ids for optimistic sends (the Worker dedupes on them for 10 minutes). */
export function clientId(): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return `pf${Date.now().toString(36)}${rand}`
}
