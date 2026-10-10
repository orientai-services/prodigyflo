import { describe, expect, it } from 'vitest'
import { dockVisible, onCallDesk } from './dock'

describe('call bar visibility', () => {
  it('always shows on the Call Center desk', () => {
    expect(dockVisible({ pathname: '/call-center', status: 'idle' })).toBe(true)
    expect(dockVisible({ pathname: '/call-center/anything', status: 'idle' })).toBe(true)
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
  })

  it('matches the desk path exactly, not a prefix of another word', () => {
    expect(onCallDesk('/call-center')).toBe(true)
    expect(onCallDesk('/call-centerx')).toBe(false)
    expect(onCallDesk(undefined)).toBe(false)
  })
})
