import { it, expect, vi } from 'vitest'
import { signupAction } from './actions'
it('requires a Super Admin invitation even when the retired signup toggle is enabled', async () => {
  vi.stubEnv('ALLOW_SELF_SIGNUP', 'true')
  expect(await signupAction({}, new FormData())).toEqual({ error: 'Staff access requires an invitation from a Super Admin.' })
  vi.unstubAllEnvs()
})
