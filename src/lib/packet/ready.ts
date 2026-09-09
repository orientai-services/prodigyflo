import type { Closeability } from './schema'
import { str } from './schema'

export type ReadyInput = {
  first_name: string
  last_name: string
  phone: string
  email: string
  property_street: string
  city: string
  state: string
  zip: string
  product_confirmed: string
  lender_confirmed: string
  monthly: string
  has_contract: boolean
  has_finance: boolean
}

export type ReadyResult = {
  ready: boolean
  closeability: Closeability
  missing: string[]
}

const PRODUCTS = new Set(['loan', 'lease', 'ppa'])

export function evaluateReady(input: ReadyInput): ReadyResult {
  const missing: string[] = []
  const need = [
    ['first_name', input.first_name],
    ['last_name', input.last_name],
    ['phone', input.phone],
    ['email', input.email],
    ['property_street', input.property_street],
    ['city', input.city],
    ['state', input.state],
    ['zip', input.zip],
  ] as const
  for (const [k, v] of need) if (!str(v)) missing.push(k)

  const product = str(input.product_confirmed).toLowerCase()
  if (!PRODUCTS.has(product)) missing.push('product_confirmed')

  const lender = str(input.lender_confirmed).toLowerCase()
  if (!lender || lender === 'unknown' || lender === 'not sure') missing.push('lender_confirmed')

  if (!str(input.monthly)) missing.push('monthly')

  const signed = input.has_contract || input.has_finance
  if (!signed) missing.push('signed_agreement')

  const identityMissing = ['first_name', 'last_name', 'phone', 'email', 'property_street', 'city', 'state', 'zip']
    .some((k) => missing.includes(k))

  if (missing.length === 0) return { ready: true, closeability: 'A', missing }
  if (identityMissing || !signed) return { ready: false, closeability: 'C', missing }
  return { ready: false, closeability: 'B', missing }
}
