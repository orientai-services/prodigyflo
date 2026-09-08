import { describe, expect, it } from 'vitest'
import { renderSignature } from '@/lib/messaging/signature'

const base = {
  name: 'Hector Camarena',
  nickname: 'Hex',
  title: 'Founder',
  phone: '(702) 555-0100',
  emailAlias: 'hector',
  signatureIncludePhone: true,
}

describe('email signatures', () => {
  it('formal: full name, title, company, phone, alias', () => {
    const sig = renderSignature({ ...base, signatureStyle: 'formal' }, 'ProdigyFlo')
    expect(sig.split('\n')).toEqual([
      'Hector Camarena',
      'Founder',
      'ProdigyFlo',
      '(702) 555-0100',
      'hector@prodigyflo.ai',
    ])
  })

  it('friendly: nickname-led with a dash, condensed context', () => {
    const sig = renderSignature({ ...base, signatureStyle: 'friendly' }, 'ProdigyFlo')
    expect(sig.startsWith('— Hex')).toBe(true)
    expect(sig).toContain('Founder · ProdigyFlo')
  })

  it('friendly without a nickname falls back to the full name', () => {
    const sig = renderSignature({ ...base, nickname: null, signatureStyle: 'friendly' }, 'ProdigyFlo')
    expect(sig.startsWith('— Hector Camarena')).toBe(true)
  })

  it('phone can be excluded; missing alias drops the address line', () => {
    const sig = renderSignature(
      { ...base, signatureIncludePhone: false, emailAlias: null, signatureStyle: 'formal' },
      'ProdigyFlo',
    )
    expect(sig).not.toContain('555')
    expect(sig).not.toContain('@')
  })

  it('empty optional fields never leave blank lines', () => {
    const sig = renderSignature(
      { name: 'A B', nickname: null, title: null, phone: null, emailAlias: null, signatureStyle: 'formal', signatureIncludePhone: true },
      'Org',
    )
    expect(sig.split('\n').every((l) => l.trim().length > 0)).toBe(true)
  })
})
