import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  redirect: vi.fn(),
  userFindFirst: vi.fn(),
  userCreate: vi.fn(),
  organizationFindUnique: vi.fn(),
  auditEventCreate: vi.fn(),
}))

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))
vi.mock('@/lib/db', () => ({
  db: {
    user: { findFirst: mocks.userFindFirst, create: mocks.userCreate },
    organization: { findUnique: mocks.organizationFindUnique },
    auditEvent: { create: mocks.auditEventCreate },
  },
}))

import { signupAction } from './actions'

function signupForm(overrides: Record<string, string> = {}) {
  const form = new FormData()
  for (const [key, value] of Object.entries({
    name: 'New Teammate',
    email: 'new.teammate@example.test',
    password: 'not-a-real-password-123',
    passwordConfirmation: 'not-a-real-password-123',
    ...overrides,
  })) form.set(key, value)
  return form
}

describe('signupAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ALLOW_SELF_SIGNUP = 'true'
    delete process.env.PUBLIC_SIGNUP_ORGANIZATION_SLUG
    mocks.userFindFirst.mockResolvedValue(null)
    mocks.organizationFindUnique.mockResolvedValue({
      id: 'prodigyflo-workspace',
      deletedAt: null,
      roles: [{ id: 'closer-role' }],
    })
    mocks.userCreate.mockResolvedValue({ id: 'new-user' })
    mocks.auditEventCreate.mockResolvedValue({})
    mocks.redirect.mockImplementation(() => { throw new Error('NEXT_REDIRECT') })
  })

  afterEach(() => {
    delete process.env.ALLOW_SELF_SIGNUP
    delete process.env.PUBLIC_SIGNUP_ORGANIZATION_SLUG
  })

  it('places a self-registered account in the shared ProdigyFlo workspace as a non-owner', async () => {
    await expect(signupAction({}, signupForm())).rejects.toThrow('NEXT_REDIRECT')

    expect(mocks.organizationFindUnique).toHaveBeenCalledWith({
      where: { slug: 'prodigyflo' },
      select: {
        id: true,
        deletedAt: true,
        roles: { where: { key: 'CLOSER' }, select: { id: true } },
      },
    })
    expect(mocks.userCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        organizationId: 'prodigyflo-workspace',
        roleId: 'closer-role',
        email: 'new.teammate@example.test',
        isOwner: false,
      }),
    }))
    expect(mocks.auditEventCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        organizationId: 'prodigyflo-workspace',
        entityType: 'User',
        entityId: 'new-user',
      }),
    }))
  })

  it('uses an explicitly configured shared-workspace slug', async () => {
    process.env.PUBLIC_SIGNUP_ORGANIZATION_SLUG = 'team-workspace'

    await expect(signupAction({}, signupForm())).rejects.toThrow('NEXT_REDIRECT')

    expect(mocks.organizationFindUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { slug: 'team-workspace' },
    }))
  })

  it('does not create an isolated workspace if shared-workspace setup is missing', async () => {
    mocks.organizationFindUnique.mockResolvedValue(null)

    await expect(signupAction({}, signupForm())).resolves.toEqual({
      error: 'Registration is temporarily unavailable. Please contact your administrator.',
    })
    expect(mocks.userCreate).not.toHaveBeenCalled()
  })

  it('keeps the public-registration feature gate closed by default', async () => {
    process.env.ALLOW_SELF_SIGNUP = 'false'

    await expect(signupAction({}, signupForm())).resolves.toEqual({
      error: 'Self-service signup is not enabled for this site.',
    })
    expect(mocks.organizationFindUnique).not.toHaveBeenCalled()
  })
})
