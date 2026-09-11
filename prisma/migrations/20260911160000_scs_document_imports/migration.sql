CREATE TYPE "ExternalDocumentImportStatus" AS ENUM ('PENDING', 'IMPORTING', 'IMPORTED', 'FAILED');

CREATE TABLE "ExternalDocumentImport" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "intakeSubmissionId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "sourceDocumentId" TEXT NOT NULL,
  "sourceLeadId" TEXT,
  "sourceFileName" TEXT,
  "sourceDocumentType" TEXT,
  "sourceMimeType" TEXT,
  "sourceSizeBytes" INTEGER,
  "status" "ExternalDocumentImportStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "sourceChecksum" TEXT,
  "importedChecksum" TEXT,
  "clientDocumentId" TEXT,
  "importedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExternalDocumentImport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExternalDocumentImport_clientDocumentId_key" ON "ExternalDocumentImport"("clientDocumentId");
CREATE UNIQUE INDEX "ExternalDocumentImport_intakeSubmissionId_sourceDocumentId_key" ON "ExternalDocumentImport"("intakeSubmissionId", "sourceDocumentId");
CREATE INDEX "ExternalDocumentImport_organizationId_status_idx" ON "ExternalDocumentImport"("organizationId", "status");
CREATE INDEX "ExternalDocumentImport_clientId_idx" ON "ExternalDocumentImport"("clientId");

ALTER TABLE "ExternalDocumentImport"
  ADD CONSTRAINT "ExternalDocumentImport_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ExternalDocumentImport_intakeSubmissionId_fkey" FOREIGN KEY ("intakeSubmissionId") REFERENCES "IntakeSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ExternalDocumentImport_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ExternalDocumentImport_clientDocumentId_fkey" FOREIGN KEY ("clientDocumentId") REFERENCES "ClientDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
