/**
 * Internal closer checklist — not legal advice, not a homeowner lecture.
 *
 * Federal TILA / Holder / FTC Cooling-Off apply in every state. State rows add
 * that state's home-solicitation window, contractor board, recovery fund (if
 * any), AG desk, and solar-specific disclosure notes. Confirm the notice that
 * is actually on THIS packet. Do not invent a statute citation the file does
 * not support.
 */

export type StateLever = {
  code: string
  name: string
  /** Home-solicitation / door-to-door analog. FTC floor is 3 business days. */
  coolingOffBusinessDays: number
  contractorBoard: string
  recoveryFund: string | null
  ag: string
  /** Extra solar / home-improvement disclosure notes for this state. */
  solar: string | null
  udap: string
}

const D = (
  code: string,
  name: string,
  patch: Partial<Omit<StateLever, 'code' | 'name'>> = {},
): StateLever => ({
  code,
  name,
  coolingOffBusinessDays: 3,
  contractorBoard: `${name} contractor licensing board`,
  recoveryFund: null,
  ag: `${name} Attorney General — consumer protection`,
  solar: null,
  udap: `${name} unfair / deceptive practices (UDAP) statute`,
  ...patch,
})

/** 50 states + DC + PR. Overrides only where solar/home-improvement desks are well-known. */
export const STATE_LEVERS: Record<string, StateLever> = {
  AL: D('AL', 'Alabama', { contractorBoard: 'Alabama Licensing Board for General Contractors' }),
  AK: D('AK', 'Alaska', { contractorBoard: 'Alaska Division of Corporations, Business and Professional Licensing' }),
  AZ: D('AZ', 'Arizona', {
    contractorBoard: 'Arizona Registrar of Contractors (ROC)',
    recoveryFund: 'Arizona ROC Residential Contractors Recovery Fund (if eligible)',
    solar: 'Arizona solar / ROC complaint path. Home solicitation cooling-off still applies if sold in the home.',
  }),
  AR: D('AR', 'Arkansas', { contractorBoard: 'Arkansas Contractors Licensing Board' }),
  CA: D('CA', 'California', {
    contractorBoard: 'Contractors State License Board (CSLB)',
    recoveryFund: 'CSLB Consumer Recovery Account (if eligible)',
    solar: 'California home-solicitation cancellation (Civ. Code) plus solar-specific consumer disclosures. Confirm which cancellation notice and solar disclosure were actually delivered.',
    ag: 'California DOJ / Attorney General consumer complaint',
  }),
  CO: D('CO', 'Colorado', {
    contractorBoard: 'Colorado Department of Regulatory Agencies — construction / solar as licensed',
    solar: 'Colorado solar installer registration / consumer-protection overlay. Confirm current DORA desk.',
  }),
  CT: D('CT', 'Connecticut', { contractorBoard: 'Connecticut Department of Consumer Protection — occupational licensing' }),
  DE: D('DE', 'Delaware', { contractorBoard: 'Delaware Division of Professional Regulation' }),
  DC: D('DC', 'District of Columbia', {
    contractorBoard: 'DC Department of Licensing and Consumer Protection',
    ag: 'DC Office of the Attorney General — consumer protection',
  }),
  FL: D('FL', 'Florida', {
    contractorBoard: 'Florida DBPR Construction Industry Licensing Board',
    solar: 'Florida home-solicitation / home-improvement cancellation plus solar contractor licensing. Confirm the notice attached to THIS contract.',
    ag: 'Florida AG — Consumer Protection',
    udap: 'Florida Deceptive and Unfair Trade Practices Act (FDUTPA)',
  }),
  GA: D('GA', 'Georgia', {
    contractorBoard: 'Georgia State Licensing Board for Residential and General Contractors',
    solar: 'Georgia Fair Business Practices Act + home-solicitation cancellation. Solar often sits under residential contractor licensing.',
  }),
  HI: D('HI', 'Hawaii', {
    contractorBoard: 'Hawaii Contractors License Board (DCCA)',
    solar: 'Hawaii has an active solar-contractor market; use DCCA contractor complaints plus state cooling-off if sold away from the seller’s place of business.',
  }),
  ID: D('ID', 'Idaho', { contractorBoard: 'Idaho Division of Occupational and Professional Licenses — contractors' }),
  IL: D('IL', 'Illinois', {
    contractorBoard: 'Illinois Department of Financial and Professional Regulation / local roofing-solar licensing where required',
    solar: 'Illinois Home Repair and Remodeling Act + consumer fraud act. Confirm in-home sale notices.',
  }),
  IN: D('IN', 'Indiana', { contractorBoard: 'Indiana Professional Licensing Agency / local contractor licensing' }),
  IA: D('IA', 'Iowa', { contractorBoard: 'Iowa Department of Inspections, Appeals, and Licensing — labor/contractor' }),
  KS: D('KS', 'Kansas', { contractorBoard: 'Kansas Attorney General / local contractor licensing (no single statewide board for all trades)' }),
  KY: D('KY', 'Kentucky', { contractorBoard: 'Kentucky Department of Housing, Buildings and Construction' }),
  LA: D('LA', 'Louisiana', { contractorBoard: 'Louisiana State Licensing Board for Contractors' }),
  ME: D('ME', 'Maine', { contractorBoard: 'Maine Professional and Financial Regulation' }),
  MD: D('MD', 'Maryland', {
    contractorBoard: 'Maryland Home Improvement Commission (MHIC)',
    recoveryFund: 'Maryland Home Improvement Guaranty Fund (if eligible)',
    solar: 'Maryland home-improvement / solar often runs through MHIC. Confirm license and Guaranty Fund eligibility before citing it.',
  }),
  MA: D('MA', 'Massachusetts', {
    contractorBoard: 'Massachusetts Office of Consumer Affairs / state construction supervisor licensing',
    solar: 'Massachusetts home-solicitation 3-day plus 209A-adjacent consumer regs. Home Improvement Contractor program where it applies.',
  }),
  MI: D('MI', 'Michigan', { contractorBoard: 'Michigan LARA — Corporations, Securities and Commercial Licensing (builders)' }),
  MN: D('MN', 'Minnesota', { contractorBoard: 'Minnesota Department of Labor and Industry — residential contractors' }),
  MS: D('MS', 'Mississippi', { contractorBoard: 'Mississippi State Board of Contractors' }),
  MO: D('MO', 'Missouri', { contractorBoard: 'Missouri Attorney General / local contractor licensing' }),
  MT: D('MT', 'Montana', { contractorBoard: 'Montana Department of Labor and Industry — construction contractors' }),
  NE: D('NE', 'Nebraska', { contractorBoard: 'Nebraska Department of Labor — contractor registration' }),
  NV: D('NV', 'Nevada', {
    contractorBoard: 'Nevada State Contractors Board (NSCB)',
    recoveryFund: 'Nevada Recovery Fund (if eligible)',
    solar: 'Nevada residential contractor disclosures, mechanics-lien warnings, and Recovery Fund notices often appear on the install agreement. Use only if they are on THIS packet.',
  }),
  NH: D('NH', 'New Hampshire', { contractorBoard: 'New Hampshire Attorney General Consumer Protection / local licensing' }),
  NJ: D('NJ', 'New Jersey', {
    contractorBoard: 'New Jersey Division of Consumer Affairs — Home Improvement / contractors',
    solar: 'New Jersey home-improvement contractor registration plus Consumer Fraud Act. Strong UDAP desk for sales-practice files.',
  }),
  NM: D('NM', 'New Mexico', {
    contractorBoard: 'New Mexico Regulation and Licensing Department — Construction Industries',
    solar: 'New Mexico Construction Industries Division complaints for solar installers.',
  }),
  NY: D('NY', 'New York', {
    contractorBoard: 'New York Department of State / local home-improvement licensing (NYC: DCWP)',
    solar: 'New York home-improvement 3-day (GBL) plus General Business Law deceptive-practices. NYC files may also use DCWP.',
  }),
  NC: D('NC', 'North Carolina', {
    contractorBoard: 'North Carolina Licensing Board for General Contractors',
    solar: 'North Carolina home-solicitation cooling-off plus AG consumer complaints. Solar often under general contractor / specialty.',
  }),
  ND: D('ND', 'North Dakota', { contractorBoard: 'North Dakota Secretary of State contractor licensing' }),
  OH: D('OH', 'Ohio', { contractorBoard: 'Ohio Attorney General Consumer Protection / local contractor licensing' }),
  OK: D('OK', 'Oklahoma', { contractorBoard: 'Oklahoma Construction Industries Board' }),
  OR: D('OR', 'Oregon', {
    contractorBoard: 'Oregon Construction Contractors Board (CCB)',
    recoveryFund: 'Oregon CCB Complaint / bond path (if eligible)',
    solar: 'Oregon CCB is the primary solar-installer complaint desk.',
  }),
  PA: D('PA', 'Pennsylvania', {
    contractorBoard: 'Pennsylvania Attorney General Bureau of Consumer Protection / local contractor licensing',
    solar: 'Pennsylvania Home Improvement Consumer Protection Act (HICPA) registration and cancellation rules where the job is home improvement.',
  }),
  PR: D('PR', 'Puerto Rico', {
    contractorBoard: 'Puerto Rico Department of Consumer Affairs (DACO)',
    ag: 'DACO consumer complaint',
  }),
  RI: D('RI', 'Rhode Island', { contractorBoard: 'Rhode Island Contractors’ Registration and Licensing Board' }),
  SC: D('SC', 'South Carolina', {
    contractorBoard: 'South Carolina LLR — Residential Builders Commission',
    solar: 'South Carolina residential builder / specialty contractor complaints plus AG consumer.',
  }),
  SD: D('SD', 'South Dakota', { contractorBoard: 'South Dakota Attorney General / local contractor licensing' }),
  TN: D('TN', 'Tennessee', { contractorBoard: 'Tennessee Board for Licensing Contractors' }),
  TX: D('TX', 'Texas', {
    contractorBoard: 'Texas Department of Licensing and Regulation (TDLR) / local contractor licensing',
    solar: 'Texas Deceptive Trade Practices Act (DTPA) is the primary UDAP hammer. Home-solicitation cancellation if sold in the home. Confirm TDLR vs municipal license.',
    ag: 'Texas AG Consumer Protection / DTPA',
    udap: 'Texas Deceptive Trade Practices Act (DTPA)',
  }),
  UT: D('UT', 'Utah', {
    contractorBoard: 'Utah Division of Occupational and Professional Licensing (DOPL) — contractors',
    solar: 'Utah solar-sales / contractor overlay. Confirm DOPL license and any solar-specific disclosure on the packet.',
  }),
  VT: D('VT', 'Vermont', { contractorBoard: 'Vermont Secretary of State / Attorney General consumer' }),
  VA: D('VA', 'Virginia', {
    contractorBoard: 'Virginia Board for Contractors (DPOR)',
    solar: 'Virginia contractor licensing plus home-solicitation cooling-off.',
  }),
  WA: D('WA', 'Washington', {
    contractorBoard: 'Washington Department of Labor & Industries — contractor registration',
    solar: 'Washington contractor registration complaints plus Consumer Protection Act.',
  }),
  WV: D('WV', 'West Virginia', { contractorBoard: 'West Virginia Division of Labor — contractor licensing' }),
  WI: D('WI', 'Wisconsin', { contractorBoard: 'Wisconsin Department of Safety and Professional Services / local licensing' }),
  WY: D('WY', 'Wyoming', { contractorBoard: 'Wyoming Attorney General / local contractor licensing' }),
}

export function leverFor(state: string): StateLever {
  const code = state.trim().toUpperCase()
  return STATE_LEVERS[code] ?? D(code || '??', code ? `State ${code}` : 'Unknown state')
}

export type FederalLeverInput = {
  product: string
  hasFinance: boolean
  inHomeOrTablet: boolean
  coolingOffExpired: boolean | null
  saleOrRefi: boolean
}

/**
 * Federal stack for every financed solar file. TILA rescission is NOT assumed
 * for equipment-only UCC-1 loans — only if the note is secured by the dwelling.
 */
export function federalLevers(input: FederalLeverInput): string[] {
  const financed = input.hasFinance || /loan|lease|ppa/i.test(input.product)
  const lines: string[] = []

  lines.push(
    'Federal FTC Cooling-Off Rule (16 CFR 429): 3 business days to cancel a sale made at the home or a temporary location, not at the seller’s place of business. Confirm the sale location from the packet / sales trail. If the 3-day notice is missing on an in-home sale, that is a federal notice defect — not a guess.',
  )

  if (financed) {
    lines.push(
      'Federal TILA / Regulation Z: APR, amount financed, finance charge, and payment schedule on the loan/lease paper must match what was disclosed. Pull the TILA box. Do not invent APR. A disclosure mismatch is a TILA lever; it is not automatic loan death.',
    )
    lines.push(
      'Federal TILA rescission (15 U.S.C. § 1635): the 3-business-day right to rescind applies only if this credit is secured by the client’s principal dwelling. An equipment-only UCC-1 on the panels often is NOT dwelling-secured. Confirm the security language on the note before using rescission talk. If it is a refinance/home-equity style solar loan, rescission may still be in play — only after the paper says so.',
    )
    lines.push(
      'Federal FTC Holder Rule (16 CFR 433): if the consumer credit contract contains the Holder Notice (“ANY HOLDER OF THIS CONSUMER CREDIT CONTRACT IS SUBJECT TO ALL CLAIMS AND DEFENSES…”), installer misrepresentation / breach / warranty claims can be raised against the lender as defenses. If the notice is not on THIS note, do not assume Holder.',
    )
  }

  if (input.inHomeOrTablet) {
    lines.push(
      'Sale looks in-home / tablet. Stack FTC Cooling-Off + this state’s home-solicitation statute. Missing cancellation-notice forms are a notice defect. Confirm copies in the packet.',
    )
  }

  if (input.saleOrRefi) {
    lines.push(
      'Federal / UCC: a fixture filing can cloud sale or refinance. Confirm via that state’s UCC search. Never invent a filing number. Title-cloud pressure is leverage after it is confirmed.',
    )
  }

  return lines
}

export function stateLeversForFile(state: string): string[] {
  const s = leverFor(state)
  const lines = [
    `${s.name} (${s.code || 'ST'}): home-solicitation cooling-off is ${s.coolingOffBusinessDays} business days if this was sold away from the seller’s place of business. Confirm sale location.`,
    `${s.name} contractor desk: ${s.contractorBoard}. File there in parallel with the lender demand — not as the first sentence of the call.`,
    `${s.name} UDAP: ${s.udap}. Sales-practice / savings-claim files run here after the packet is documented.`,
    `AG desk: ${s.ag}.`,
  ]
  if (s.recoveryFund) lines.push(`${s.name} recovery / guaranty path: ${s.recoveryFund}. Cite only if this installer/job is eligible — confirm before promising a fund payout.`)
  if (s.solar) lines.push(`${s.name} solar overlay: ${s.solar}`)
  return lines
}
