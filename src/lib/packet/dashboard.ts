import { str } from './schema'

export type DashboardFields = Record<string, string>

export function buildDashboardPayload(fields: DashboardFields): string {
  const order = [
    'First name',
    'Last name',
    'Phone',
    'Email',
    'Property street',
    'City',
    'State',
    'ZIP',
    'Mailing same as property',
    'Installer',
    'Install date',
    'Lender',
    'Product',
    'Account or loan #',
    'Original contract value',
    'Current payoff',
    'Monthly payment',
    'APR',
    'First-year monthly payment',
    'Payment basis',
    'Annual payment escalation',
    'Contract effective date',
    'Customer signature date',
    'Actual in-service date',
    'Term starts',
    'Term months',
    'Payment start date',
    'Utility company',
    'Utility monthly pre/post',
    'Pain type',
    'Complaint summary',
    'Docs attach order',
    'Notes for closer',
    'Fee trench',
    'Assigned path',
  ]
  const lines = order.map((k) => `${k}: ${str(fields[k]) || 'MISSING'}`)
  lines.push('Submit: WAIT FOR HUMAN')
  return lines.join('\n')
}
