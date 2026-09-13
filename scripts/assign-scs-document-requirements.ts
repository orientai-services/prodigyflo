/** Backfill imported SCS documents into the specific upload area that sent them. */
import { db } from '@/lib/db'
import { scsRequirementId } from '@/lib/intake/scs-document-requirements'

const execute = process.argv.includes('--execute')

async function main() {
  const rows = await db.externalDocumentImport.findMany({
    where: { status: 'IMPORTED', clientDocumentId: { not: null } },
    select: {
      organizationId: true,
      sourceDocumentType: true,
      clientDocument: { select: { id: true, requirementId: true } },
    },
  })
  const totals = { imported: rows.length, alreadyAssigned: 0, assigned: 0, unmappedType: 0 }
  for (const row of rows) {
    const document = row.clientDocument
    if (!document) continue
    if (document.requirementId) {
      totals.alreadyAssigned++
      continue
    }
    const requirementId = await scsRequirementId(row.organizationId, row.sourceDocumentType)
    if (!requirementId) {
      totals.unmappedType++
      continue
    }
    totals.assigned++
    if (execute) {
      await db.clientDocument.update({ where: { id: document.id }, data: { requirementId } })
    }
  }
  console.log(JSON.stringify({ mode: execute ? 'execute' : 'dry-run', ...totals }))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await db.$disconnect()
  })
