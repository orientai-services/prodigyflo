/** Guarded, transactional consolidation. Defaults to ROLLBACK; never exports rows. */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { CLOSER_PERMISSIONS, ALL_PERMISSIONS, PERMISSIONS } from '../src/lib/permissions'

// Deliberately reviewed, not a blanket mutation of every future org-scoped table.
const ORG_TABLES = [
  'AdSet', 'AuditEvent', 'Campaign', 'Client', 'CloserBrief', 'CoachingNote', 'Connector',
  'ConnectorCredential', 'CysFieldDefinition', 'DeployRun', 'DocumentPackage', 'EngineRun',
  'ExternalDocumentImport', 'HotLeadReview', 'InboundDocument', 'InboundEvent', 'Insight',
  'IntakeSource', 'IntakeSubmission', 'Invite', 'LeadSource', 'MessageTemplate', 'Notification',
  'NurtureTouch', 'PhoneNumber', 'Pipeline', 'Region', 'Role', 'SavedFilter', 'ScheduledMessage',
  'Sequence', 'Survey', 'Team', 'TelephonyWallet', 'User', 'WalletEntry',
].sort()
const q = (name: string) => '"' + name.replaceAll('"', '""') + '"'
export type MergeOptions = { sourceId: string; targetId: string; commit?: boolean; runId?: string }
export type MergeReport = { runId: string; committed: boolean; clients: number; documents: number; historicalUsers: number; archivedRows: number; tablesChecked: number }

export async function mergeWorkspace(pg: PoolClient, options: MergeOptions): Promise<MergeReport> {
  const { sourceId, targetId, commit = false } = options
  if (!sourceId || !targetId || sourceId === targetId) throw new Error('Distinct source and target organization IDs are required.')
  const runId = options.runId ?? randomUUID()
  const both = [sourceId, targetId]
  await pg.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
  try {
    await pg.query("SET LOCAL lock_timeout='15s'")
    await pg.query("SET LOCAL statement_timeout='5min'")
    await pg.query("SELECT pg_advisory_xact_lock(hashtext('prodigy-workspace-merge'))")
    const catalog = await pg.query<{ table_name: string }>(`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='organizationId' ORDER BY table_name`)
    if (JSON.stringify(catalog.rows.map(r => r.table_name)) !== JSON.stringify(ORG_TABLES)) throw new Error('Organization table catalog changed; review the migration allowlist before proceeding.')
    const all = await pg.query<{ table_name: string }>(`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='id' AND table_name <> '_prisma_migrations' ORDER BY table_name`)
    // Block concurrent writes to every affected table, including child records and intake.
    await pg.query(`LOCK TABLE ${all.rows.map(r => q(r.table_name)).join(', ')}, "RolePermission" IN EXCLUSIVE MODE`)
    const orgs = await pg.query(`SELECT id, "deletedAt" FROM "Organization" WHERE id=ANY($1::text[])`, [both])
    if (orgs.rowCount !== 2 || orgs.rows.some(r => r.deletedAt)) throw new Error('Both organizations must exist and be active.')
    if ((await pg.query(`SELECT id FROM "Organization" WHERE "parentOrganizationId"=ANY($1::text[])`, [both])).rowCount) throw new Error('Child organizations need an explicit migration decision.')
    if ((await pg.query(`SELECT id FROM "PhoneNumber" WHERE "organizationId"=$1 AND status <> 'RELEASED'`, [sourceId])).rowCount) throw new Error('Legacy phone numbers require a provider retirement/repointing plan first.')
    if ((await pg.query(`SELECT id FROM "TelephonyWallet" WHERE "organizationId"=$1 AND ("balanceCents" <> 0 OR "autoReloadEnabled")`, [sourceId])).rowCount) throw new Error('Reconcile the legacy wallet before consolidation; balances are never silently combined.')
    for (const field of ['email', 'emailAlias']) {
      const collision = await pg.query(`SELECT 1 FROM "User" a JOIN "User" b ON lower(a.${q(field)})=lower(b.${q(field)}) WHERE a."organizationId"=$1 AND b."organizationId"=$2 LIMIT 1`, both)
      if (collision.rowCount) throw new Error(`User ${field} collision requires a reviewed identity mapping.`)
    }
    if ((await pg.query(`SELECT 1 FROM "Client" a JOIN "Client" b ON a."instagramUserId"=b."instagramUserId" WHERE a."organizationId"=$1 AND b."organizationId"=$2 LIMIT 1`, both)).rowCount) throw new Error('Instagram identities collide; no clients will be merged automatically.')
    const targetUsers = await pg.query(`SELECT u.id FROM "User" u JOIN "Role" r ON r.id=u."roleId" WHERE u."organizationId"=$1 AND u."isActive" AND u."deletedAt" IS NULL AND r.key IN ('SUPER_ADMIN','ADMIN')`, [targetId])
    if (!targetUsers.rowCount) throw new Error('No current target staff would remain as Super Admin.')
    const defaults = await pg.query(`SELECT id FROM "Pipeline" WHERE "organizationId"=$1 AND "isDefault"`, [targetId])
    if (defaults.rowCount !== 1) throw new Error('Exactly one target default pipeline is required.')
    const pipelineId = defaults.rows[0].id
    if ((await pg.query(`SELECT 1 FROM "Client" c JOIN "PipelineStage" old ON old.id=c."currentStageId" WHERE c."organizationId"=ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM "PipelineStage" s WHERE s."pipelineId"=$2 AND s.key=old.key)`, [both, pipelineId])).rowCount) throw new Error('The target pipeline lacks an existing client stage.')
    const definitionCount = await pg.query(`SELECT count(*)::int AS n FROM "CysFieldDefinition" WHERE "organizationId"=$1 AND "isActive"`, [targetId])
    if (definitionCount.rows[0].n !== 42) throw new Error('The target workspace must have all 42 active CYS definitions.')

    // Snapshot all changed org-owned records plus their mutable child/config rows.
    for (const table of ['Organization', ...ORG_TABLES]) {
      await pg.query(`INSERT INTO "WorkspaceMigrationArchive" ("runId","tableName","recordId",payload) SELECT $1,$2,id,to_jsonb(t) FROM ${q(table)} t WHERE ${table === 'Organization' ? 'id' : '"organizationId"'}=ANY($3::text[])`, [runId, table, both])
    }
    for (const [table, condition] of [
      ['RolePermission', '"roleId" IN (SELECT id FROM "Role" WHERE "organizationId"=ANY($3::text[]))'],
      ['Appointment', '"clientId" IN (SELECT id FROM "Client" WHERE "organizationId"=ANY($3::text[]))'],
      ['Assignment', '"clientId" IN (SELECT id FROM "Client" WHERE "organizationId"=ANY($3::text[]))'],
      ['ClientDocument', '"clientId" IN (SELECT id FROM "Client" WHERE "organizationId"=ANY($3::text[]))'],
      ['AuthToken', '"userId" IN (SELECT id FROM "User" WHERE "organizationId"=ANY($3::text[]))'],
      ['UserSession', '"userId" IN (SELECT id FROM "User" WHERE "organizationId"=ANY($3::text[]))'],
      ['ConnectorLog', '"connectorId" IN (SELECT id FROM "Connector" WHERE "organizationId"=ANY($3::text[]))'],
    ]) await pg.query(`INSERT INTO "WorkspaceMigrationArchive" ("runId","tableName","recordId",payload) SELECT $1,$2,COALESCE(to_jsonb(t)->>'id',md5(to_jsonb(t)::text)),to_jsonb(t) FROM ${q(table)} t WHERE ${condition}`, [runId, table, both])
    // IDs in all tables must survive, or their exact original row must be archived.
    const ids = new Map<string, string[]>()
    for (const { table_name: table } of all.rows) ids.set(table, (await pg.query(`SELECT id FROM ${q(table)}`)).rows.map(r => r.id))
    const documentBefore = await pg.query(`SELECT md5(COALESCE(string_agg(to_jsonb(d)::text, '' ORDER BY id),'')) AS hash, count(*)::int AS n FROM "ClientDocument" d`)
    const clientCount = await pg.query(`SELECT count(*)::int AS n FROM "Client" WHERE "organizationId"=ANY($1::text[])`, [both])
    const historical = await pg.query(`SELECT id FROM "User" WHERE "organizationId"=$1`, [sourceId])

    const roleIds: Record<string, string> = {}
    for (const key of ['SUPER_ADMIN','CLOSER']) {
      const role = await pg.query(`INSERT INTO "Role" (id,"organizationId",key,name,"isSystem","createdAt","updatedAt") VALUES ($1,$2,$3::"RoleKey",$4,true,now(),now()) ON CONFLICT ("organizationId",key) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [randomUUID(), targetId, key, key === 'SUPER_ADMIN' ? 'Super Admin' : 'Closer'])
      roleIds[key] = role.rows[0].id
      await pg.query(`DELETE FROM "RolePermission" WHERE "roleId"=$1`, [roleIds[key]])
      for (const permission of key === 'SUPER_ADMIN' ? ALL_PERMISSIONS : CLOSER_PERMISSIONS) {
        const p = await pg.query(`INSERT INTO "Permission" (id,key,description,category) VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO UPDATE SET description=EXCLUDED.description RETURNING id`, [randomUUID(), permission, PERMISSIONS[permission].description, PERMISSIONS[permission].category])
        await pg.query(`INSERT INTO "RolePermission" ("roleId","permissionId") VALUES ($1,$2)`, [roleIds[key], p.rows[0].id])
      }
    }
    const team = await pg.query(`SELECT id FROM "Team" WHERE "organizationId"=$1 ORDER BY "createdAt",id LIMIT 1`, [targetId])
    const teamId = team.rows[0]?.id ?? randomUUID()
    await pg.query(`INSERT INTO "Team" (id,"organizationId",name,"createdAt","updatedAt") VALUES ($1,$2,'Team Prodigy',now(),now()) ON CONFLICT (id) DO UPDATE SET name='Team Prodigy',"regionId"=NULL,"managerId"=NULL,"deletedAt"=NULL`, [teamId, targetId])
    await pg.query(`UPDATE "User" SET "isActive"=false,"isOwner"=false,"roleId"=$2,"teamId"=$3,"regionId"=NULL,"managerId"=NULL,"landingPath"=NULL WHERE "organizationId"=$1`, [sourceId, roleIds.CLOSER, teamId])
    await pg.query(`UPDATE "User" u SET "roleId"=CASE WHEN id=ANY($2::text[]) THEN $3 ELSE $4 END,"isActive"=CASE WHEN id=ANY($2::text[]) THEN true ELSE (u."isActive" AND EXISTS (SELECT 1 FROM "Role" r WHERE r.id=u."roleId" AND r.key='CLOSER')) END,"isOwner"=false,"teamId"=$5,"regionId"=NULL,"managerId"=NULL,"landingPath"=NULL WHERE "organizationId"=$1`, [targetId, targetUsers.rows.map(r=>r.id), roleIds.SUPER_ADMIN, roleIds.CLOSER, teamId])
    await pg.query(`UPDATE "AuthToken" SET "usedAt"=COALESCE("usedAt",now()) WHERE "userId"=ANY($1::text[])`, [historical.rows.map(r=>r.id)])
    await pg.query(`UPDATE "UserSession" SET "revokedAt"=COALESCE("revokedAt",now()) WHERE "userId"=ANY($1::text[])`, [historical.rows.map(r=>r.id)])
    await pg.query(`UPDATE "Invite" SET "revokedAt"=COALESCE("revokedAt",now()),"roleId"=$2,"teamId"=$3,"regionId"=NULL,"isOwner"=false WHERE "organizationId"=ANY($1::text[])`, [both, roleIds.CLOSER, teamId])
    await pg.query(`UPDATE "Client" c SET "ownerId"=CASE WHEN EXISTS (SELECT 1 FROM "User" u JOIN "Role" r ON r.id=u."roleId" WHERE u.id=c."ownerId" AND u."isActive" AND u."deletedAt" IS NULL AND r.key='CLOSER') THEN c."ownerId" ELSE NULL END,"teamId"=$2,"regionId"=NULL,"portalUserId"=NULL,"pipelineId"=$3,"currentStageId"=s.id FROM "PipelineStage" old JOIN "PipelineStage" s ON s.key=old.key AND s."pipelineId"=$3 WHERE c."currentStageId"=old.id AND c."organizationId"=ANY($1::text[])`, [both, teamId, pipelineId])
    await pg.query(`UPDATE "Appointment" a SET "ownerId"=(SELECT "ownerId" FROM "Client" WHERE id=a."clientId") WHERE "clientId" IN (SELECT id FROM "Client" WHERE "organizationId"=ANY($1::text[])) AND "startsAt">=now() AND status IN ('SCHEDULED','CONFIRMED')`, [both])
    await pg.query(`UPDATE "Assignment" SET "isActive"=false,"unassignedAt"=COALESCE("unassignedAt",now()) WHERE "clientId" IN (SELECT id FROM "Client" WHERE "organizationId"=ANY($1::text[])) AND "isActive" AND "assigneeId" IS DISTINCT FROM (SELECT "ownerId" FROM "Client" WHERE id="Assignment"."clientId")`, [both])
    await pg.query(`UPDATE "IntakeSource" SET "defaultTeamId"=$2,"defaultOwnerId"=NULL WHERE "organizationId"=ANY($1::text[])`, [both, teamId])
    // Source integrations must not start sending/billing under the target workspace.
    await pg.query(`UPDATE "IntakeSource" SET "isEnabled"=false WHERE "organizationId"=$1`, [sourceId])
    await pg.query(`UPDATE "Connector" SET "isEnabled"=false WHERE "organizationId"=$1`, [sourceId])
    await pg.query(`UPDATE "Pipeline" SET "isDefault"=false WHERE "organizationId"=$1`, [sourceId])
    await pg.query(`UPDATE "DocumentPackage" SET "isDefault"=false WHERE "organizationId"=$1`, [sourceId])
    // Pause legacy scheduled automation but retain all enrollment/history rows.
    await pg.query(`UPDATE "Sequence" SET "isActive"=false WHERE "organizationId"=$1`, [sourceId])
    await pg.query(`UPDATE "ScheduledMessage" SET status='CANCELLED' WHERE "organizationId"=$1 AND status='PENDING'`, [sourceId])

    // Colliding immutable provider identifiers stop the run; local names can be namespaced.
    for (const [table, field, extra] of [['LeadSource','key',''], ['IntakeSource','slug',''], ['MessageTemplate','key','AND b.locale=a.locale']]) {
      await pg.query(`UPDATE ${q(table)} a SET ${q(field)}='legacy-' || a.id || '-' || a.${q(field)} WHERE a."organizationId"=$1 AND EXISTS (SELECT 1 FROM ${q(table)} b WHERE b."organizationId"=$2 AND b.${q(field)}=a.${q(field)} ${extra})`, both)
    }
    for (const table of ['InboundDocument', 'AdSet']) {
      if ((await pg.query(`SELECT 1 FROM ${q(table)} a JOIN ${q(table)} b ON a."externalId"=b."externalId" WHERE a."organizationId"=$1 AND b."organizationId"=$2 LIMIT 1`, both)).rowCount) throw new Error(`${table} external identifiers collide; preserve both with an explicitly reviewed mapping.`)
    }
    const connectors = await pg.query(`SELECT a.id,b.id AS target FROM "Connector" a JOIN "Connector" b ON a.kind=b.kind WHERE a."organizationId"=$1 AND b."organizationId"=$2`, both)
    for (const connector of connectors.rows) {
      await pg.query(`UPDATE "ConnectorLog" SET "connectorId"=$2 WHERE "connectorId"=$1`, [connector.id, connector.target])
      await pg.query(`DELETE FROM "ConnectorCredential" WHERE "connectorId"=$1`, [connector.id])
      await pg.query(`DELETE FROM "Connector" WHERE id=$1`, [connector.id])
    }
    await pg.query(`DELETE FROM "CysFieldDefinition" a WHERE a."organizationId"=$1 AND EXISTS (SELECT 1 FROM "CysFieldDefinition" b WHERE b."organizationId"=$2 AND b.key=a.key)`, both)
    // Extra source definitions remain as historical fields rather than expanding the 42.
    await pg.query(`UPDATE "CysFieldDefinition" SET "isActive"=false WHERE "organizationId"=$1`, [sourceId])
    await pg.query(`UPDATE "CysFieldDefinition" SET "sourcePath"='document.product_type' WHERE "organizationId"=$1 AND key='product_confirmed' AND "sourcePath"='document.solar_contract.installer_name'`, [targetId])
    await pg.query(`DELETE FROM "RolePermission" WHERE "roleId" IN (SELECT id FROM "Role" WHERE "organizationId"=ANY($1::text[]) AND id<>ALL($2::text[]))`, [both, Object.values(roleIds)])
    await pg.query(`DELETE FROM "Role" WHERE "organizationId"=ANY($1::text[]) AND id<>ALL($2::text[])`, [both, Object.values(roleIds)])
    await pg.query(`DELETE FROM "Team" WHERE "organizationId"=ANY($1::text[]) AND id<>$2`, [both, teamId])
    await pg.query(`DELETE FROM "Region" WHERE "organizationId"=ANY($1::text[])`, [both])
    await pg.query(`DELETE FROM "WalletEntry" WHERE "organizationId"=$1`, [sourceId])
    await pg.query(`DELETE FROM "TelephonyWallet" WHERE "organizationId"=$1`, [sourceId])
    for (const table of ORG_TABLES) await pg.query(`UPDATE ${q(table)} SET "organizationId"=$2 WHERE "organizationId"=$1`, both)
    for (const table of ORG_TABLES) if ((await pg.query(`SELECT 1 FROM ${q(table)} WHERE "organizationId"=$1 LIMIT 1`, [sourceId])).rowCount) throw new Error(`Unmoved organization reference in ${table}`)
    await pg.query(`UPDATE "Organization" SET name='Team Prodigy',kind='CLIENT',"parentOrganizationId"=NULL WHERE id=$1`, [targetId])
    await pg.query(`DELETE FROM "Organization" WHERE id=$1`, [sourceId])
    for (const [table, before] of ids) {
      const missing = await pg.query(`SELECT original FROM unnest($1::text[]) original WHERE NOT EXISTS (SELECT 1 FROM ${q(table)} t WHERE t.id=original) AND NOT EXISTS (SELECT 1 FROM "WorkspaceMigrationArchive" a WHERE a."runId"=$2 AND a."tableName"=$3 AND a."recordId"=original) LIMIT 1`, [before, runId, table])
      if (missing.rowCount) throw new Error(`Unarchived record loss in ${table}`)
    }
    const documentAfter = await pg.query(`SELECT md5(COALESCE(string_agg(to_jsonb(d)::text, '' ORDER BY id),'')) AS hash FROM "ClientDocument" d`)
    if (documentBefore.rows[0].hash !== documentAfter.rows[0].hash) throw new Error('Document rows changed; rolling back.')
    const finalCount = await pg.query(`SELECT count(*)::int AS n FROM "Client" WHERE "organizationId"=$1`, [targetId])
    if (finalCount.rows[0].n !== clientCount.rows[0].n) throw new Error('Client count changed; rolling back.')
    const archived = await pg.query(`SELECT count(*)::int AS n FROM "WorkspaceMigrationArchive" WHERE "runId"=$1`, [runId])
    const report = { runId, committed: commit, clients: finalCount.rows[0].n, documents: documentBefore.rows[0].n, historicalUsers: historical.rowCount ?? 0, archivedRows: archived.rows[0].n, tablesChecked: ids.size }
    await pg.query(commit ? 'COMMIT' : 'ROLLBACK')
    return report
  } catch (error) {
    await pg.query('ROLLBACK')
    throw error
  }
}
