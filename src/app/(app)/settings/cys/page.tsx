import { Badge } from '@/components/ui/badge'
import { db } from '@/lib/db'
import { canAny, requirePermissionPage } from '@/lib/rbac'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { ActiveToggle, DefinitionEditor, type EditableDefinition } from './field-editor'
import { SOURCE_TYPE_LABELS } from './constants'

export const metadata = { title: 'CYS field map' }

/**
 * The configurable CYS field map. There is no CYS API — these definitions
 * describe the shape of the handover package staff deliver manually.
 */
export default async function CysSettingsPage() {
  const user = await requirePermissionPage('submissions:prepare')
  const canEdit = canAny(user, ['pipeline:configure', 'org:manage'])

  const definitions = await db.cysFieldDefinition.findMany({
    where: { organizationId: user.organizationId },
    orderBy: [{ groupName: 'asc' }, { position: 'asc' }, { key: 'asc' }],
  })

  const groups = new Map<string, typeof definitions>()
  for (const def of definitions) {
    const list = groups.get(def.groupName) ?? []
    list.push(def)
    groups.set(def.groupName, list)
  }

  return (
    <>
      <PageHeader
        title="CYS field map"
        description="Which fields the CYS handover package contains and where each value is sourced from. Delivery to CYS is manual — no API connection exists."
        actions={canEdit ? <DefinitionEditor /> : undefined}
      />

      {definitions.length === 0 ? (
        <EmptyState
          icon="Map"
          title="No CYS fields defined yet"
          description={
            canEdit
              ? 'Add the fields the CYS handover package must contain.'
              : 'An administrator has not configured the CYS field map yet.'
          }
        />
      ) : (
        <div className="space-y-6 p-4 sm:p-6">
          {[...groups.entries()].map(([groupName, defs]) => (
            <section key={groupName}>
              <h2 className="mb-2 text-sm font-semibold">{groupName}</h2>
              <div className="scroll-x rounded-lg border">
                <table className="w-full min-w-[48rem] text-sm tabular-nums">
                  <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                    <tr className="border-b">
                      <th className="px-4 py-2 text-left">#</th>
                      <th className="px-4 py-2 text-left">Field</th>
                      <th className="px-4 py-2 text-left">Source</th>
                      <th className="px-4 py-2 text-left">Type</th>
                      <th className="px-4 py-2 text-left">Required</th>
                      <th className="px-4 py-2 text-left">Active</th>
                      {canEdit && <th className="px-4 py-2 text-right">Edit</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {defs.map((def) => (
                      <tr key={def.id} className="border-b last:border-0 align-top">
                        <td className="text-muted-foreground px-4 py-2.5 tabular-nums">{def.position}</td>
                        <td className="px-4 py-2.5">
                          <span className="font-medium">{def.label}</span>
                          <span className="text-muted-foreground block font-mono text-xs">{def.key}</span>
                          {def.helpText && (
                            <span className="text-muted-foreground block text-xs">{def.helpText}</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge variant="secondary">{SOURCE_TYPE_LABELS[def.sourceType]}</Badge>
                          {def.sourcePath && (
                            <span className="text-muted-foreground block font-mono text-xs">
                              {def.sourcePath}
                            </span>
                          )}
                        </td>
                        <td className="text-muted-foreground px-4 py-2.5 text-xs">{def.dataType}</td>
                        <td className="px-4 py-2.5">
                          {def.isRequired ? (
                            <Badge variant="outline" className="text-destructive border-destructive/30">
                              Required
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground text-xs">Optional</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          {canEdit ? (
                            <ActiveToggle id={def.id} label={def.label} isActive={def.isActive} />
                          ) : def.isActive ? (
                            <Badge variant="secondary">Active</Badge>
                          ) : (
                            <span className="text-muted-foreground text-xs">Inactive</span>
                          )}
                        </td>
                        {canEdit && (
                          <td className="px-4 py-2.5 text-right">
                            <DefinitionEditor definition={def as EditableDefinition} />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  )
}
