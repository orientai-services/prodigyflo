/**
 * Template rendering. Isomorphic on purpose: the composer renders live previews
 * in the browser with the same code the send service runs on the server, so
 * what the rep sees is exactly what goes out.
 *
 * Variables use `{{snake_case}}` syntax. A message containing an unresolved
 * placeholder is never sent — `unresolved` must be empty before a send.
 */

export type TemplateVars = Record<string, string | null | undefined>

const VAR_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g

export type RenderedTemplate = {
  subject: string | null
  body: string
  /** Placeholder names that had no value (missing, null, or empty string). */
  unresolved: string[]
}

function renderString(input: string, vars: TemplateVars, unresolved: Set<string>): string {
  return input.replace(VAR_RE, (_, name: string) => {
    const value = vars[name]
    if (value === undefined || value === null || value === '') {
      unresolved.add(name)
      return `{{${name}}}`
    }
    return value
  })
}

export function renderTemplate(
  template: { subject?: string | null; body: string },
  vars: TemplateVars,
): RenderedTemplate {
  const unresolved = new Set<string>()
  const subject = template.subject ? renderString(template.subject, vars, unresolved) : null
  const body = renderString(template.body, vars, unresolved)
  return { subject, body, unresolved: [...unresolved] }
}

/**
 * Locale selection: exact match first, then English, then nothing. A client
 * whose language has no translation still gets a correct (English) message
 * rather than none.
 */
export function pickTemplate<T extends { locale: string }>(candidates: T[], locale: string): T | null {
  return (
    candidates.find((t) => t.locale === locale) ??
    candidates.find((t) => t.locale === 'en') ??
    null
  )
}

/** The variables every template can rely on, resolved from the client record. */
export function baseVarsForClient(client: {
  firstName: string
  lastName: string
  email: string
  phone: string
  owner?: { name: string } | null
  organization?: { name: string } | null
}): TemplateVars {
  return {
    first_name: client.firstName,
    last_name: client.lastName,
    full_name: `${client.firstName} ${client.lastName}`.trim(),
    email: client.email,
    phone: client.phone,
    owner_name: client.owner?.name ?? '',
    company_name: client.organization?.name ?? '',
  }
}

/** Variable names offered in the template editor helper text. */
export const KNOWN_VARIABLES = [
  'first_name',
  'last_name',
  'full_name',
  'email',
  'phone',
  'owner_name',
  'company_name',
  'appointment_date',
  'appointment_type',
  'appointment_location',
  'document_name',
] as const
