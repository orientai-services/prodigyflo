import { describe, expect, it } from 'vitest'
import { clientScope } from '@/lib/rbac'

describe('test harness', () => {
  it('resolves the @ alias and server-only stub', () => {
    expect(typeof clientScope).toBe('function')
  })
})
