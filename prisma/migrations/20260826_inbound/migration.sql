-- CreateEnum
CREATE TYPE "InboundCategory" AS ENUM ('CONTACT', 'DOCUMENT', 'OPPORTUNITY', 'NOTE', 'APPOINTMENT', 'OTHER');

-- CreateTable
CREATE TABLE "InboundEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "connectorDefId" TEXT,
    "submissionId" TEXT,
    "clientId" TEXT,
    "category" "InboundCategory" NOT NULL DEFAULT 'OTHER',
    "eventType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL DEFAULT '{}',
    "normalized" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundDocument" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT,
    "sourceId" TEXT,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT,
    "url" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboundDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InboundEvent_organizationId_createdAt_idx" ON "InboundEvent"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "InboundEvent_organizationId_category_idx" ON "InboundEvent"("organizationId", "category");

-- CreateIndex
CREATE INDEX "InboundEvent_clientId_idx" ON "InboundEvent"("clientId");

-- CreateIndex
CREATE INDEX "InboundEvent_sourceId_idx" ON "InboundEvent"("sourceId");

-- CreateIndex
CREATE INDEX "InboundDocument_organizationId_clientId_idx" ON "InboundDocument"("organizationId", "clientId");

-- CreateIndex
CREATE INDEX "InboundDocument_organizationId_status_idx" ON "InboundDocument"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InboundDocument_organizationId_externalId_key" ON "InboundDocument"("organizationId", "externalId");

-- AddForeignKey
ALTER TABLE "InboundEvent" ADD CONSTRAINT "InboundEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundEvent" ADD CONSTRAINT "InboundEvent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundDocument" ADD CONSTRAINT "InboundDocument_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundDocument" ADD CONSTRAINT "InboundDocument_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
