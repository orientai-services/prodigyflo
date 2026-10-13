import { describe, expect, it } from 'vitest'
import { profileName } from './profile-name'

describe('profileName', () => {
  it('prefers the nickname, then the profile name', () => {
    expect(profileName({ name: 'Gatsby Smith', nickname: 'Gats' })).toBe('Gats')
    expect(profileName({ name: 'Gatsby Smith', nickname: ' ' })).toBe('Gatsby Smith')
  })
  it('never returns an email', () => {
    expect(profileName({ name: 'gatsby.smith@example.com' })).toBe('Gatsby Smith')
    expect(profileName({ name: 'hycama@gmail.com', nickname: 'hycama@gmail.com' })).toBe('Hycama')
    expect(profileName({ name: '', email: 'vic_gomez22@example.com' })).toBe('Vic Gomez')
    expect(profileName({ name: 'x@y.com', nickname: 'Hector' })).toBe('Hector')
  })
  it('returns null when there is nothing to show', () => {
    expect(profileName({ name: '', email: '' })).toBeNull()
    expect(profileName({ name: '123@x.com' })).toBeNull()
  })
})
