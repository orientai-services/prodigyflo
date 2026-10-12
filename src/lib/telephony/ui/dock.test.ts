import { describe, expect, it } from 'vitest'
import { dockVisible, onCallDesk } from './dock'

describe('call bar visibility', () => {
  it('folds away on the Call Center desk while idle: the header pill holds the phone there', () => {
    expect(dockVisible({ pathname: '/call-center', status: 'idle' })).toBe(false)
    expect(dockVisible({ pathname: '/call-center/anything', status: 'idle' })).toBe(false)
  })

  it('shows on the desk for a call, and for a dial error until it is dismissed', () => {
    for (const status of ['connecting', 'ringing', 'in-call'] as const) {
      expect(dockVisible({ pathname: '/call-center', status })).toBe(true)
    }
    expect(dockVisible({ pathname: '/call-center', status: 'idle', error: true })).toBe(true)
    expect(dockVisible({ pathname: '/call-center', status: 'idle', callError: true })).toBe(true)
  })

  it('hides elsewhere while idle', () => {
    for (const pathname of ['/board', '/clients/abc', '/', '/call-centers', null]) {
      expect(dockVisible({ pathname, status: 'idle' })).toBe(false)
    }
  })

  it('shows elsewhere while a call is connecting, ringing or live', () => {
    for (const status of ['connecting', 'ringing', 'in-call'] as const) {
      expect(dockVisible({ pathname: '/clients/abc', status })).toBe(true)
    }
  })

  it('stays elsewhere until the error of the call that just ended is dismissed', () => {
    expect(dockVisible({ pathname: '/board', status: 'idle', callError: true })).toBe(true)
    expect(dockVisible({ pathname: '/board', status: 'idle', callError: false })).toBe(false)
    // A dial error with no call behind it belongs to the page that dialed.
    expect(dockVisible({ pathname: '/board', status: 'idle', error: true })).toBe(false)
  })

  it('matches the desk path exactly, not a prefix of another word', () => {
    expect(onCallDesk('/call-center')).toBe(true)
    expect(onCallDesk('/call-centerx')).toBe(false)
    expect(onCallDesk(undefined)).toBe(false)
  })
})
