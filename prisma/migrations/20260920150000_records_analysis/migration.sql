ALTER TABLE "ExternalDocumentImport" ADD COLUMN "sourceAnalysis" JSONB;
ALTER TABLE "DocumentExtraction" ADD COLUMN "sourceIdentity" TEXT;
ALTER TABLE "DocumentExtraction" ADD COLUMN "sourceEvidence" JSONB;
CREATE UNIQUE INDEX "DocumentExtraction_sourceIdentity_key" ON "DocumentExtraction"("sourceIdentity");

ALTER TABLE "ExternalDocumentImport" ADD COLUMN "analysisIdentity" TEXT, ADD COLUMN "analysisPending" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "analysisError" TEXT;
CREATE INDEX "ExternalDocumentImport_analysisPending_idx" ON "ExternalDocumentImport" ("analysisPending");

CREATE TABLE "RecordsAnalysisJob" (
 "id" TEXT PRIMARY KEY, "documentId" TEXT NOT NULL UNIQUE REFERENCES "ClientDocument"("id") ON DELETE CASCADE,
 "extractionId" TEXT NOT NULL UNIQUE, "status" TEXT NOT NULL DEFAULT 'PENDING', "state" JSONB,
 "attempts" INTEGER NOT NULL DEFAULT 0,"error" TEXT,"nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "claimedAt" TIMESTAMP(3),"claimToken" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "RecordsAnalysisJob_status_nextAttemptAt_idx" ON "RecordsAnalysisJob"("status","nextAttemptAt");
