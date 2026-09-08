import { parseUsd } from './money'

/**
 * Grammar for the `fb>` console on /marketing/meta. Parsing is pure and shared
 * between the client island (instant feedback, suggestions) and the server
 * action (authoritative dispatch onto the same gated operations the buttons
 * use). The parser never touches the network or the DB — it only turns a line
 * of text into a typed command or a typed complaint.
 */

export type ConsoleCommand =
  | { kind: 'help' }
  | { kind: 'list' }
  | { kind: 'spend'; days: number }
  | { kind: 'status'; ref: string; status: 'ACTIVE' | 'PAUSED' }
  | { kind: 'budget'; ref: string; usd: number }
  | { kind: 'cap'; ref: string; usd: number }
  | { kind: 'create-account'; name: string; currency: string; timezone: string }

export type ConsoleParse =
  | { ok: true; command: ConsoleCommand }
  | { ok: false; error: string }

export const CONSOLE_COMMANDS: { name: string; usage: string; description: string }[] = [
  { name: 'help', usage: 'help', description: 'Show this command list.' },
  { name: 'list', usage: 'list', description: 'Campaigns with their ad sets, status, budget, and spend.' },
  { name: 'spend', usage: 'spend [days]', description: 'Daily spend totals for the last N days (default 7).' },
  { name: 'pause', usage: 'pause <id|name>', description: 'Pause a campaign or ad set.' },
  { name: 'resume', usage: 'resume <id|name>', description: 'Resume a paused campaign or ad set.' },
  { name: 'budget', usage: 'budget <id|name> <usd>', description: 'Set the DAILY budget of a campaign or ad set.' },
  { name: 'cap', usage: 'cap <id|name> <usd>', description: 'Set a campaign LIFETIME spend cap (min $100 — not a daily budget).' },
  { name: 'create-account', usage: 'create-account "<name>" [currency] [timezone-id]', description: 'Create a new ad account under the business.' },
]

/** Splits a command line into tokens, honoring double-quoted phrases. */
export function tokenize(input: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(input)) !== null) tokens.push(m[1] ?? m[2])
  return tokens
}

function amountOrError(raw: string | undefined, what: string): { usd: number } | { error: string } {
  if (!raw) return { error: `Missing amount — e.g. \`${what} camp-123 50\`.` }
  const usd = parseUsd(raw)
  if (usd === null) return { error: `"${raw}" is not a dollar amount. Try 50 or $1,250.50.` }
  return { usd }
}

export function parseConsoleCommand(input: string): ConsoleParse {
  const tokens = tokenize(input)
  if (tokens.length === 0) return { ok: false, error: 'Type a command — `help` lists them.' }

  const verb = tokens[0].toLowerCase()
  const rest = tokens.slice(1)

  switch (verb) {
    case 'help':
    case '?':
      return { ok: true, command: { kind: 'help' } }

    case 'list':
    case 'ls':
      return { ok: true, command: { kind: 'list' } }

    case 'spend': {
      if (rest.length === 0) return { ok: true, command: { kind: 'spend', days: 7 } }
      const days = Number(rest[0])
      if (!Number.isInteger(days) || days < 1 || days > 90) {
        return { ok: false, error: 'Days must be a whole number from 1 to 90.' }
      }
      return { ok: true, command: { kind: 'spend', days } }
    }

    case 'pause':
    case 'resume': {
      const ref = rest.join(' ').trim()
      if (!ref) return { ok: false, error: `Which one? \`${verb} <id or name>\`.` }
      return { ok: true, command: { kind: 'status', ref, status: verb === 'pause' ? 'PAUSED' : 'ACTIVE' } }
    }

    case 'budget': {
      if (rest.length < 2) return { ok: false, error: 'Usage: budget <id|name> <usd> — daily budget in dollars.' }
      const amount = amountOrError(rest[rest.length - 1], 'budget')
      if ('error' in amount) return { ok: false, error: amount.error }
      const ref = rest.slice(0, -1).join(' ').trim()
      if (!ref) return { ok: false, error: 'Usage: budget <id|name> <usd>.' }
      return { ok: true, command: { kind: 'budget', ref, usd: amount.usd } }
    }

    case 'cap': {
      if (rest.length < 2) return { ok: false, error: 'Usage: cap <id|name> <usd> — LIFETIME spend cap, min $100.' }
      const amount = amountOrError(rest[rest.length - 1], 'cap')
      if ('error' in amount) return { ok: false, error: amount.error }
      const ref = rest.slice(0, -1).join(' ').trim()
      if (!ref) return { ok: false, error: 'Usage: cap <id|name> <usd>.' }
      return { ok: true, command: { kind: 'cap', ref, usd: amount.usd } }
    }

    case 'create-account': {
      const [name, currency, timezone] = rest
      if (!name) {
        return { ok: false, error: 'Usage: create-account "<name>" [currency] [timezone-id] — quote names with spaces.' }
      }
      return {
        ok: true,
        command: {
          kind: 'create-account',
          name,
          currency: (currency ?? 'USD').toUpperCase(),
          timezone: timezone ?? '1',
        },
      }
    }

    default:
      return { ok: false, error: `Unknown command "${verb}" — \`help\` lists what fb> understands.` }
  }
}
