/**
 * Two call packets.
 *
 * The case review is what the closer shows the client.
 * The closer pitch stays on the closer's screen.
 * Stage directions, fee tactics, and the statute strategy name stay off the review.
 */

import type { CloserWinInput } from './closer-win'
import { composeMasterCallSheet, consumerRightsPoster } from './call-sheet'
import { leverFor, STATE_LEVERS } from './state-levers'
import { str } from './schema'

export type CallAudience = 'review' | 'pitch'

export type CallPacket = {
  audience: CallAudience
  filename: string
  title: string
  pages: string[]
  input: CloserWinInput
}

const CLOSER_ONLY = [
  'STOP after the ask',
  'Do not drop the fee',
  'Count to eight',
  'This sheet stays on your screen',
]

function known(state: string): boolean {
  const code = state.trim().toUpperCase()
  return code.length === 2 && Boolean(STATE_LEVERS[code])
}

function statuteName(state: string): string {
  if (!known(state)) return 'the consumer statute for the property state, once that state is confirmed'
  return leverFor(state).udap
}

export function closerCredit(input: CloserWinInput): string {
  const name = str(input.closerName) || 'Unassigned'
  const title = str(input.closerTitle)
  return title ? `${name} | ${title} | Cancel Your Solar` : `${name} | Cancel Your Solar`
}

function safeName(input: CloserWinInput): string {
  const last = str(input.lastName).replace(/[^A-Za-z0-9]+/g, '') || 'Client'
  return last
}

export function clientReviewPacket(input: CloserWinInput): CallPacket {
  const sheet = composeMasterCallSheet(input)
  const name = `${str(input.firstName)} ${str(input.lastName)}`.trim()
  const statute = statuteName(input.state)
  const stateName = known(input.state) ? leverFor(input.state).name : 'the property state'
  const pages = [
    [
      'Your Case Review',
      `Prepared for ${name}`,
      facts(sheet.sections[0]?.facts ?? []),
      closerCredit(input),
      'This review is not legal advice. Counsel evaluates independently.',
    ].join('\n\n'),
    ['What You Signed', 'The contract', facts(sheet.sections[0]?.facts ?? []), 'What this means', sheet.sections[0]?.say ?? ''].join('\n\n'),
    ['What Changed', sheet.sections[1]?.say ?? ''].join('\n\n'),
    ['The Numbers', sheet.sections[2]?.say ?? '', facts(sheet.sections[2]?.facts ?? [])].join('\n\n'),
    ['What Your Bills Actually Show', sheet.sections[3]?.say ?? ''].join('\n\n'),
    [
      'Three Facts Counsel Will Use',
      `1. Tax-credit promise vs. the paper. ${statute}: credits and rebates belong where this contract assigns them. A promise that is not in the contract is not in the contract.`,
      `2. Savings pitch vs. the utility on this file. ${stateName} is the property state. Do not quote a rate or a bill amount that is not on the file.`,
      '3. Payment terms on the contract. Read the escalator and any production guarantee from this agreement. Do not add a term that is not on the page.',
    ].join('\n\n'),
    [
      'Where We Go From Here',
      sheet.sections[4]?.say ?? '',
      `Lien status. Quote only the lien language in this contract. Counsel pulls the county record and the ${stateName} UCC registry. Do not invent a filing number.`,
    ].join('\n\n'),
    [
      'Documents We Still Need',
      ...sheet.documents.map((doc, index) => `${index + 1}. ${doc.item} — ${index === 1 || index === 2 ? `Priority - ${statute}` : doc.note}`),
      'Reply with items 2 and 3 first.',
    ].join('\n'),
  ]
  return {
    audience: 'review',
    filename: `${safeName(input)}-case-review.pdf`,
    title: `Your Case Review - ${name}`,
    pages,
    input,
  }
}

export function closerPitchPacket(input: CloserWinInput): CallPacket {
  const sheet = composeMasterCallSheet(input)
  const rights = consumerRightsPoster(input)
  const statute = statuteName(input.state)
  const pages = [
    [
      'MASTER CALL SHEET / CLOSER',
      `${closerCredit(input)}. This sheet stays on your screen. Share the case review, not this sheet.`,
      `Opening. ${sheet.opening}`,
      `What you signed. ${sheet.sections[0]?.say ?? ''}`,
      `What changed. ${sheet.sections[1]?.say ?? ''}`,
      `The money. ${sheet.sections[2]?.say ?? ''} The processing fee is only the fee written on this engagement. Do not drop the fee. Do not invent one.`,
      `Reality check. ${sheet.sections[3]?.say ?? ''}`,
    ].join('\n\n'),
    [
      `Three facts counsel uses · ${statute}`,
      ...rights.state.map((line) => `State. ${line}`),
      ...rights.federal.map((line) => `Federal. ${line}`),
      `Two options. ${sheet.sections[4]?.say ?? ''}`,
      `THE ASK. ${sheet.ask}`,
      'STOP after the ask. Count to eight. Do not add another reason.',
      'Documents',
      ...sheet.documents.map((doc, index) => `${index + 1}. ${doc.item} — ${doc.note}`),
    ].join('\n\n'),
    [
      'Objection handles. One sentence, then re-ask.',
      'If they say the system saved money: agree with what the bills on file show, then return to the contract.',
      'If they want a lower fee: the authorized fee is the fee on the engagement. Do not quote a different number.',
      'If they want to think: ask what the open question is, and book the follow-up before the call ends.',
      `If they ask about a filing: ${statute} does not invent a filing number. Confirm the county record and the state UCC registry.`,
      'Close hygiene. Never say the file can be cancelled. Say counsel evaluates independently.',
      sheet.disclaimer,
    ].join('\n\n'),
  ]
  return {
    audience: 'pitch',
    filename: `${safeName(input)}-closer-pitch.pdf`,
    title: 'Closer pitch',
    pages,
    input,
  }
}

export function callPacket(input: CloserWinInput, audience: CallAudience): CallPacket {
  return audience === 'review' ? clientReviewPacket(input) : closerPitchPacket(input)
}

export function reviewLeaksCloserScript(packet: CallPacket): string[] {
  const text = packet.pages.join('\n')
  return CLOSER_ONLY.filter((phrase) => text.includes(phrase))
}

function facts(rows: { label: string; value: string }[]): string {
  return rows.map((row) => `${row.label}: ${row.value}`).join('\n')
}
