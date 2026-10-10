/**
 * Same house for contract evidence.
 * Street spelling can change. A different house number, city, state, or ZIP cannot.
 */
export type StreetAddress = { line1: string; city: string; state: string; postalCode: string }

export function sameContractProperty(before: StreetAddress, after: StreetAddress): boolean {
  const house = (line: string) => (/^\s*(\d+)/.exec(line) ?? [])[1] ?? ''
  const zip = (value: string) => value.trim().slice(0, 5)
  const text = (value: string) => value.trim().toLowerCase()
  const beforeHouse = house(before.line1)
  const beforeZip = zip(before.postalCode)
  if (!beforeHouse || beforeHouse !== house(after.line1)) return false
  if (beforeZip.length < 5 || beforeZip !== zip(after.postalCode)) return false
  if (!text(before.city) || text(before.city) !== text(after.city)) return false
  if (!text(before.state) || text(before.state) !== text(after.state)) return false
  return true
}

export type ContractClient = StreetAddress & { firstName: string; lastName: string }

/** Same person and the same house. Street spelling may differ. */
export function sameContractClient(recorded: ContractClient, live: ContractClient): boolean {
  const text = (value: string) => value.trim().toLowerCase()
  if (!text(recorded.firstName) || text(recorded.firstName) !== text(live.firstName)) return false
  if (!text(recorded.lastName) || text(recorded.lastName) !== text(live.lastName)) return false
  return sameContractProperty(recorded, live)
}

/**
 * A later SCS packet repeats the address typed at intake. Keep a corrected
 * street on the same house. A different house number, city, state, or ZIP
 * replaces the profile address.
 */
export function profileAddressAfterPacket(current: StreetAddress | null, incoming: StreetAddress): { address: StreetAddress; sameHouse: boolean } {
  if (current && sameContractProperty(current, incoming)) return { address: current, sameHouse: true }
  return { address: incoming, sameHouse: false }
}
