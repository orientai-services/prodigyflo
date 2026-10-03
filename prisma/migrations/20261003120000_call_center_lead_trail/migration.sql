-- Additive Call Center trail. Does not change Client, User, intake, board, documents, or CYS.

CREATE TYPE "CallCenterLeadSource" AS ENUM ('FORM', 'INBOUND');
CREATE TYPE "CallCenterLeadLanguage" AS ENUM ('EN', 'ES');
CREATE TYPE "CallCenterLeadStatus" AS ENUM ('WAITING', 'INBOUND', 'MISSED', 'BOOKED');
CREATE TYPE "CallCenterEventType" AS ENUM ('FORM', 'INBOUND', 'CALL', 'SMS', 'MESSENGER', 'OUTCOME', 'NOTE', 'INTAKE_LINK', 'LOCK');

CREATE TABLE "CallCenterLead" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "pageId" TEXT,
    "source" "CallCenterLeadSource" NOT NULL,
    "language" "CallCenterLeadLanguage" NOT NULL,
    "status" "CallCenterLeadStatus" NOT NULL DEFAULT 'WAITING',
    "tries" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "doNotCallAt" TIMESTAMP(3),
    "intakeLinkSentAt" TIMESTAMP(3),
    "clientId" TEXT,
    "phoneLast4" VARCHAR(4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallCenterLead_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CallCenterEvent" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "type" "CallCenterEventType" NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallCenterEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CallCenterSuppression" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "numberHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallCenterSuppression_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CallCenterLead_organizationId_status_idx" ON "CallCenterLead"("organizationId", "status");
CREATE INDEX "CallCenterLead_organizationId_nextAttemptAt_idx" ON "CallCenterLead"("organizationId", "nextAttemptAt");
CREATE INDEX "CallCenterLead_clientId_idx" ON "CallCenterLead"("clientId");
CREATE INDEX "CallCenterEvent_leadId_createdAt_idx" ON "CallCenterEvent"("leadId", "createdAt");
CREATE UNIQUE INDEX "CallCenterSuppression_organizationId_numberHash_key" ON "CallCenterSuppression"("organizationId", "numberHash");
CREATE INDEX "CallCenterSuppression_organizationId_idx" ON "CallCenterSuppression"("organizationId");

ALTER TABLE "CallCenterLead" ADD CONSTRAINT "CallCenterLead_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallCenterEvent" ADD CONSTRAINT "CallCenterEvent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "CallCenterLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallCenterSuppression" ADD CONSTRAINT "CallCenterSuppression_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
