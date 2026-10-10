/**
 * For test files whose subject is NOT calling hours (messaging, automation):
 * runs the real outbound decision, with the clock pinned to a Wednesday at
 * 11:00 am Pacific, so their sends don't pass or fail with the time of day the
 * suite happens to run. Calling hours have their own tests in
 * src/lib/telephony/*.test.ts and tests/telephony-*.test.ts.
 *
 *   vi.mock('@/lib/telephony/compliance', pinnedCallingClock)
 */
export const PINNED_CALLING_NOW = new Date('2026-10-07T18:00:00.000Z')

export async function pinnedCallingClock(importOriginal: <T>() => Promise<T>) {
  const real = await importOriginal<typeof import('@/lib/telephony/compliance')>()
  return {
    ...real,
    decideOutbound: (
      input: Parameters<typeof real.decideOutbound>[0],
      opts: Parameters<typeof real.decideOutbound>[1] = {},
    ) => real.decideOutbound(input, { ...opts, now: opts?.now ?? PINNED_CALLING_NOW }),
  }
}
