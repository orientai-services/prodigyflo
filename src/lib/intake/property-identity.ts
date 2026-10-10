/**
 * Same house for contract evidence.
 * Street spelling can change. A different house number, city, state, or ZIP cannot.
 */
export function sameContractProperty(
  before: { line1: string; city: string; state: string; postalCode: string },
  after: { line1: string; city: string; state: string; postalCode: string },
): boolean {
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
