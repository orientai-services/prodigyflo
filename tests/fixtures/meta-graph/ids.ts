/**
 * The only two real-looking ad account ids allowed in the repo
 * (tests/meta-ads-repo-ids.test.ts enforces it):
 *  - SCS General 1, the approved account;
 *  - a FAKE foreign account used to prove nothing outside the allowlist leaks.
 * Every other id in these fixtures is synthetic and short.
 */
export const ALLOWED_ACCOUNT = 'act_1742876583597558'
export const ALLOWED_DIGITS = '1742876583597558'
export const FOREIGN_ACCOUNT = 'act_999000111222333'
export const FOREIGN_DIGITS = '999000111222333'

/** Synthetic object ids (digits, as Graph uses). */
export const IDS = {
  campaignA: '6100000001',
  campaignB: '6100000002',
  adSetA1: '6200000011',
  adSetA2: '6200000012',
  adSetB1: '6200000021',
  adA1a: '6300000111',
  adA1b: '6300000112',
  adA2a: '6300000121',
  adB1a: '6300000211',
  adArchived: '6300000299',
  /** Objects that live in the FOREIGN account. */
  foreignCampaign: '6900000001',
  foreignAdSet: '6900000011',
  foreignAd: '6900000111',
} as const

export const FOREIGN_NAMES = {
  campaign: 'ZZ Foreign Campaign Secret',
  adSet: 'ZZ Foreign AdSet Secret',
  ad: 'ZZ Foreign Ad Secret',
} as const

/** A spend figure that only the foreign account ever has, to grep for. */
export const FOREIGN_SPEND = 8765.43
