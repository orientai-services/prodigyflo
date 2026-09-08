import { requirePermissionPage } from '@/lib/rbac'
import { PageHeader } from '@/components/page-header'
import { ImportWizard } from './import-wizard'

export const metadata = { title: 'Import clients' }

export default async function ImportClientsPage() {
  await requirePermissionPage('clients:create')

  return (
    <>
      <PageHeader
        title="Import clients"
        description="Upload a CSV, map its columns, review what will happen row by row, then commit. Re-running the same file updates instead of duplicating."
      />
      <ImportWizard />
    </>
  )
}
