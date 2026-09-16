import type { Prisma } from '@prisma/client'

/** Canonical SCS intake source. Seed/demo/Meridian clients have no row here. */
export const SCS_INTAKE_SLUG = 'scs-website'

/**
 * Desk-visible: the client has an SCS intake submission, or an SCS packet
 * import (ExternalDocumentImport) even if the submission clientId was cleared.
 * Do not hide a client that has an SCS packet.
 */
export function deskVisibleClientWhere(): Prisma.ClientWhereInput {
  return {
    OR: [
      { intakeSubmissions: { some: { source: { slug: SCS_INTAKE_SLUG } } } },
      {
        externalDocumentImports: {
          some: { intakeSubmission: { source: { slug: SCS_INTAKE_SLUG } } },
        },
      },
    ],
  }
}
