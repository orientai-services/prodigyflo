import { describe, expect, it } from 'vitest'
import { languageForPageId } from './pages'

describe('languageForPageId', () => {
  it('stamps EN and ES from configured page ids and refuses a guess', () => {
    expect(languageForPageId('SES-EN')).toBe('en')
    expect(languageForPageId('SES-ES')).toBe('es')
    expect(languageForPageId('random-page')).toBeNull()
    expect(languageForPageId(undefined)).toBeNull()
  })
})
