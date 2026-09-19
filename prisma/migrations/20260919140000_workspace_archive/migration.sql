-- Deliberately has no Organization FK: retiring an organization cannot erase its archive.
CREATE TABLE "WorkspaceMigrationArchive" (
  "runId" TEXT NOT NULL,
  "tableName" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceMigrationArchive_pkey" PRIMARY KEY ("runId", "tableName", "recordId")
);
-- No application code may edit an existing snapshot.
CREATE FUNCTION preserve_workspace_archive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Workspace migration archives are immutable'; END; $$;
CREATE TRIGGER workspace_archive_immutable BEFORE UPDATE OR DELETE ON "WorkspaceMigrationArchive"
FOR EACH ROW EXECUTE FUNCTION preserve_workspace_archive();
