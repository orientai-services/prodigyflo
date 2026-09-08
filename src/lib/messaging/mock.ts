import { createHash } from 'node:crypto'
import type { EmailProvider, OutboundEmail, OutboundSms, SendResult, SmsProvider } from './provider'

/**
 * Deterministic mock adapters. The same message always yields the same
 * externalRef, and any recipient containing "fail" is rejected so failure
 * handling can be exercised without a real provider.
 */

export type MockOutboxEntry = {
  channel: 'EMAIL' | 'SMS'
  to: string
  subject: string | null
  body: string
  status: 'SENT' | 'FAILED'
  externalRef: string | null
  error: string | null
  at: string
}

// Survives module re-evaluation across Next.js dev recompiles.
const globalStore = globalThis as unknown as { __mockMessagingOutbox?: MockOutboxEntry[] }

function outbox(): MockOutboxEntry[] {
  globalStore.__mockMessagingOutbox ??= []
  return globalStore.__mockMessagingOutbox
}

/** Most recent first. In-memory only — the durable record is the Communication row. */
export function getMockOutbox(limit = 20): MockOutboxEntry[] {
  return outbox().slice(0, limit)
}

const SIMULATED_FAILURE =
  'Mock provider: recipient matched the simulated-failure rule (address/number contains "fail").'

function ref(channel: 'EMAIL' | 'SMS', parts: string[]): string {
  const digest = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12)
  return `mock-${channel.toLowerCase()}-${digest}`
}

function record(entry: Omit<MockOutboxEntry, 'at'>): SendResult {
  const box = outbox()
  box.unshift({ ...entry, at: new Date().toISOString() })
  if (box.length > 50) box.length = 50
  return entry.status === 'SENT'
    ? { status: 'SENT', externalRef: entry.externalRef }
    : { status: 'FAILED', externalRef: null, error: entry.error ?? 'Unknown mock failure' }
}

export class MockEmailProvider implements EmailProvider {
  readonly name = 'mock'

  async send(msg: OutboundEmail): Promise<SendResult> {
    if (/fail/i.test(msg.to)) {
      return record({ channel: 'EMAIL', to: msg.to, subject: msg.subject, body: msg.body, status: 'FAILED', externalRef: null, error: SIMULATED_FAILURE })
    }
    return record({
      channel: 'EMAIL',
      to: msg.to,
      subject: msg.subject,
      body: msg.body,
      status: 'SENT',
      externalRef: ref('EMAIL', [msg.to, msg.subject, msg.body]),
      error: null,
    })
  }
}

export class MockSmsProvider implements SmsProvider {
  readonly name = 'mock'

  async send(msg: OutboundSms): Promise<SendResult> {
    if (/fail/i.test(msg.to)) {
      return record({ channel: 'SMS', to: msg.to, subject: null, body: msg.body, status: 'FAILED', externalRef: null, error: SIMULATED_FAILURE })
    }
    return record({
      channel: 'SMS',
      to: msg.to,
      subject: null,
      body: msg.body,
      status: 'SENT',
      externalRef: ref('SMS', [msg.to, msg.body]),
      error: null,
    })
  }
}
