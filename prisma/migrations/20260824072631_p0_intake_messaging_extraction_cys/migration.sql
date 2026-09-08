-- CreateEnum
CREATE TYPE "IntakeSourceKind" AS ENUM ('WEB_FORM', 'GOOGLE_SHEET', 'CSV_IMPORT');

-- CreateEnum
CREATE TYPE "IntakeStatus" AS ENUM ('RECEIVED', 'APPLIED', 'DUPLICATE', 'NEEDS_MAPPING', 'FAILED');

-- CreateEnum
CREATE TYPE "ExtractionStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "FieldVerification" AS ENUM ('UNVERIFIED', 'VERIFIED', 'CORRECTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CysSourceType" AS ENUM ('CLIENT_FIELD', 'ADDRESS_FIELD', 'DOCUMENT_FIELD', 'SURVEY_FIELD', 'MANUAL');

-- CreateEnum
CREATE TYPE "CysValueStatus" AS ENUM ('MISSING', 'SUGGESTED', 'VERIFIED', 'CONFLICT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DocumentStatus" ADD VALUE 'PROCESSING';
ALTER TYPE "DocumentStatus" ADD VALUE 'MISSING_INFORMATION';

-- CreateTable
CREATE TABLE "IntakeSource" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "IntakeSourceKind" NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "secretHash" TEXT,
    "fieldMapping" JSONB NOT NULL DEFAULT '{}',
    "dedupeKeys" TEXT[] DEFAULT ARRAY['email', 'phone']::TEXT[],
    "defaultOwnerId" TEXT,
    "defaultLeadSourceId" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "sheetId" TEXT,
    "sheetTab" TEXT,
    "lastRowCursor" INTEGER NOT NULL DEFAULT 0,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntakeSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakeSubmission" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "status" "IntakeStatus" NOT NULL DEFAULT 'RECEIVED',
    "rawPayload" JSONB NOT NULL DEFAULT '{}',
    "mappedPayload" JSONB NOT NULL DEFAULT '{}',
    "unmappedKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "clientId" TEXT,
    "createdClient" BOOLEAN NOT NULL DEFAULT false,
    "matchedOn" TEXT,
    "error" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntakeSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "CommunicationChannel" NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentExtraction" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "status" "ExtractionStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "model" TEXT,
    "detectedTypeKey" TEXT,
    "detectedTypeLabel" TEXT,
    "typeConfidence" INTEGER,
    "pageCount" INTEGER,
    "rawText" TEXT,
    "summary" TEXT,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "missingFieldKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "error" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentExtraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractedField" (
    "id" TEXT NOT NULL,
    "extractionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT,
    "normalizedValue" TEXT,
    "confidence" INTEGER NOT NULL DEFAULT 0,
    "sourcePage" INTEGER,
    "sourceSnippet" TEXT,
    "verification" "FieldVerification" NOT NULL DEFAULT 'UNVERIFIED',
    "correctedValue" TEXT,
    "conflictNote" TEXT,
    "reviewerNote" TEXT,
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtractedField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CysFieldDefinition" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "groupName" TEXT NOT NULL DEFAULT 'General',
    "position" INTEGER NOT NULL DEFAULT 0,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "dataType" TEXT NOT NULL DEFAULT 'string',
    "sourceType" "CysSourceType" NOT NULL DEFAULT 'CLIENT_FIELD',
    "sourcePath" TEXT,
    "helpText" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CysFieldDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CysReadiness" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "completionPct" INTEGER NOT NULL DEFAULT 0,
    "requiredTotal" INTEGER NOT NULL DEFAULT 0,
    "requiredVerified" INTEGER NOT NULL DEFAULT 0,
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "packageJson" JSONB,
    "packageGeneratedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvalNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CysReadiness_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CysFieldValue" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "value" TEXT,
    "status" "CysValueStatus" NOT NULL DEFAULT 'MISSING',
    "confidence" INTEGER,
    "sourceLabel" TEXT,
    "sourceDocumentId" TEXT,
    "sourceExtractedFieldId" TEXT,
    "conflictValue" TEXT,
    "note" TEXT,
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CysFieldValue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntakeSource_organizationId_idx" ON "IntakeSource"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "IntakeSource_organizationId_slug_key" ON "IntakeSource"("organizationId", "slug");

-- CreateIndex
CREATE INDEX "IntakeSubmission_organizationId_status_idx" ON "IntakeSubmission"("organizationId", "status");

-- CreateIndex
CREATE INDEX "IntakeSubmission_clientId_idx" ON "IntakeSubmission"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "IntakeSubmission_sourceId_externalId_key" ON "IntakeSubmission"("sourceId", "externalId");

-- CreateIndex
CREATE INDEX "MessageTemplate_organizationId_channel_idx" ON "MessageTemplate"("organizationId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_organizationId_key_locale_key" ON "MessageTemplate"("organizationId", "key", "locale");

-- CreateIndex
CREATE INDEX "DocumentExtraction_documentId_idx" ON "DocumentExtraction"("documentId");

-- CreateIndex
CREATE INDEX "DocumentExtraction_status_idx" ON "DocumentExtraction"("status");

-- CreateIndex
CREATE INDEX "ExtractedField_extractionId_idx" ON "ExtractedField"("extractionId");

-- CreateIndex
CREATE UNIQUE INDEX "ExtractedField_extractionId_key_key" ON "ExtractedField"("extractionId", "key");

-- CreateIndex
CREATE INDEX "CysFieldDefinition_organizationId_idx" ON "CysFieldDefinition"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "CysFieldDefinition_organizationId_key_key" ON "CysFieldDefinition"("organizationId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "CysReadiness_clientId_key" ON "CysReadiness"("clientId");

-- CreateIndex
CREATE INDEX "CysFieldValue_clientId_idx" ON "CysFieldValue"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "CysFieldValue_clientId_fieldKey_key" ON "CysFieldValue"("clientId", "fieldKey");

-- AddForeignKey
ALTER TABLE "IntakeSource" ADD CONSTRAINT "IntakeSource_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeSource" ADD CONSTRAINT "IntakeSource_defaultOwnerId_fkey" FOREIGN KEY ("defaultOwnerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeSubmission" ADD CONSTRAINT "IntakeSubmission_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeSubmission" ADD CONSTRAINT "IntakeSubmission_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "IntakeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeSubmission" ADD CONSTRAINT "IntakeSubmission_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentExtraction" ADD CONSTRAINT "DocumentExtraction_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ClientDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedField" ADD CONSTRAINT "ExtractedField_extractionId_fkey" FOREIGN KEY ("extractionId") REFERENCES "DocumentExtraction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedField" ADD CONSTRAINT "ExtractedField_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CysFieldDefinition" ADD CONSTRAINT "CysFieldDefinition_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CysReadiness" ADD CONSTRAINT "CysReadiness_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CysReadiness" ADD CONSTRAINT "CysReadiness_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CysFieldValue" ADD CONSTRAINT "CysFieldValue_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CysFieldValue" ADD CONSTRAINT "CysFieldValue_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "ClientDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CysFieldValue" ADD CONSTRAINT "CysFieldValue_sourceExtractedFieldId_fkey" FOREIGN KEY ("sourceExtractedFieldId") REFERENCES "ExtractedField"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CysFieldValue" ADD CONSTRAINT "CysFieldValue_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
