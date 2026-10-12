-- Additive only: CYS sign-up hand-off to SunOff (docs/CYS_BRIDGE.md §B3, lane PF-B).
-- One enum value on CallCenterEventType (HANDOFF trail lines), one new enum and
-- one new table. Nothing is dropped, renamed or made NOT NULL on an existing
-- table, so it applies on a live database.

-- CreateEnum
CREATE TYPE "SunoffHandoffStatus" AS ENUM ('SENDING', 'STANDBY', 'STARTED', 'SUBMITTED', 'WITHDRAWN', 'ERROR');

-- AlterEnum
ALTER TYPE "CallCenterEventType" ADD VALUE 'HANDOFF';

-- CreateTable
CREATE TABLE "SunoffHandoff" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "callCenterLeadId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "sunoffLeadId" INTEGER,
    "status" "SunoffHandoffStatus" NOT NULL DEFAULT 'SENDING',
    "revision" TEXT,
    "payloadVersion" TEXT NOT NULL DEFAULT 'pf-handoff/v1',
    "manifest" JSONB NOT NULL DEFAULT '[]',
    "nonces" JSONB NOT NULL DEFAULT '{}',
    "lastSentAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "resendTries" INTEGER NOT NULL DEFAULT 0,
    "nextResendAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SunoffHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SunoffHandoff_callCenterLeadId_key" ON "SunoffHandoff"("callCenterLeadId");

-- CreateIndex
CREATE INDEX "SunoffHandoff_organizationId_status_idx" ON "SunoffHandoff"("organizationId", "status");

-- CreateIndex
CREATE INDEX "SunoffHandoff_status_nextResendAt_idx" ON "SunoffHandoff"("status", "nextResendAt");

-- AddForeignKey
ALTER TABLE "SunoffHandoff" ADD CONSTRAINT "SunoffHandoff_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SunoffHandoff" ADD CONSTRAINT "SunoffHandoff_callCenterLeadId_fkey" FOREIGN KEY ("callCenterLeadId") REFERENCES "CallCenterLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

