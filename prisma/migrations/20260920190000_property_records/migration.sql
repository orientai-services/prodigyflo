CREATE TABLE "PropertyRecordsJob" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL,
 "clientId" TEXT NOT NULL REFERENCES "Client"("id") ON DELETE CASCADE,
 "caseKey" TEXT NOT NULL, "addressVersion" TEXT NOT NULL, "address" JSONB NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'PENDING', "result" JSONB, "importedFiles" JSONB NOT NULL DEFAULT '{}',
 "attempts" INTEGER NOT NULL DEFAULT 0, "error" TEXT, "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "claimedAt" TIMESTAMP(3),"claimToken" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "PropertyRecordsJob_clientId_addressVersion_key" ON "PropertyRecordsJob"("clientId","addressVersion");
CREATE INDEX "PropertyRecordsJob_status_nextAttemptAt_idx" ON "PropertyRecordsJob"("status","nextAttemptAt");

ALTER TABLE "ExternalDocumentImport" ADD COLUMN "analysisAttempts" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "analysisNextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "DocumentExtraction" ADD COLUMN "sourceActive" BOOLEAN NOT NULL DEFAULT true;
