import { describe, expect, it } from 'vitest'
import { isRevocationText, isStartMessage, isStopMessage } from './consent'

/** STOP, START and revocation words (docs/TELEPHONY_LIVE.md §2.10). */

describe('whole-message STOP keywords (automatic)', () => {
  it.each(['STOP', 'stop.', 'Unsubscribe!', 'opt out', 'Opt-Out', 'OPTOUT', 'revoke', 'PARAR', 'alto', 'Baja', 'cancelar', 'quit', 'end', 'stop all'])(
    '%s is a STOP',
    (body) => {
      expect(isStopMessage(body)).toBe(true)
    },
  )

  it('a keyword inside a sentence is not an automatic STOP', () => {
    expect(isStopMessage('please stop texting me')).toBe(false)
    expect(isStopMessage('')).toBe(false)
  })
})

describe('START / UNSTOP', () => {
  it('re-enable only as a whole message', () => {
    expect(isStartMessage('START')).toBe(true)
    expect(isStartMessage('unstop')).toBe(true)
    expect(isStartMessage('start the project')).toBe(false)
    expect(isStartMessage('yes')).toBe(false)
  })
})

describe('revocation words inside a longer message (held for review)', () => {
  it('flags a clear request', () => {
    expect(isRevocationText('please stop texting me')).toBe(true)
    expect(isRevocationText('I want to opt out of these')).toBe(true)
    expect(isRevocationText('Don’t text me anymore, call instead')).toBe(true)
    expect(isRevocationText('STOP! wrong number')).toBe(true)
    expect(isRevocationText('Stop, not interested')).toBe(true)
    expect(isRevocationText('por favor dejen de escribirme')).toBe(true)
    expect(isRevocationText('No me envíen mensajes')).toBe(true)
    expect(isRevocationText('no más mensajes gracias')).toBe(true)
  })

  // regression-revocation-false-positives: these are ordinary replies from
  // solar-cancellation clients and must not put texts on hold.
  it.each([
    'I want to cancel my solar contract',
    'quiero cancelar mi contrato',
    'el pago es muy alto',
    'baja el pago por favor',
    "I'll call you at the end of the day",
    'my installer quit answering',
    "don't stop the project",
    'Stop by my house at 5',
    'ya no, quiero cancelar',
    'I want to revoke the contract',
  ])('does not hold an ordinary reply: %s', (body) => {
    expect(isRevocationText(body)).toBe(false)
  })

  it('a whole-message STOP is not "review", and ordinary words are not flagged', () => {
    expect(isRevocationText('STOP')).toBe(false)
    expect(isRevocationText('see you at the appointment tomorrow')).toBe(false)
    expect(isRevocationText('stopping by at noon')).toBe(false)
  })
})
