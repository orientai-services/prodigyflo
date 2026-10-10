-- Additive only: telephony live (docs/TELEPHONY_LIVE.md §5).
-- New enum, three new tables, nullable columns and indexes on existing tables.
-- Nothing is dropped, renamed or made NOT NULL on an existing table, and the
-- existing CallCenterSuppression unique (organizationId, numberHash) stays.

-- CreateEnum
CREATE TYPE "VoiceCallDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- AlterTable
ALTER TABLE "CallCenterLead" ADD COLUMN     "consentAt" TIMESTAMP(3),
ADD COLUMN     "consentFormId" TEXT,
ADD COLUMN     "consentNote" TEXT,
ADD COLUMN     "consentRevokedAt" TIMESTAMP(3),
ADD COLUMN     "consentSource" TEXT,
ADD COLUMN     "consentTextVersion" TEXT,
ADD COLUMN     "phoneHash" TEXT,
ADD COLUMN     "timeZone" TEXT;

-- AlterTable
ALTER TABLE "CallCenterSuppression" ADD COLUMN     "callBlockedAt" TIMESTAMP(3),
ADD COLUMN     "callBlockedSource" TEXT,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "last4" VARCHAR(4),
ADD COLUMN     "note" TEXT,
ADD COLUMN     "removedAt" TIMESTAMP(3),
ADD COLUMN     "removedById" TEXT,
ADD COLUMN     "smsBlockedAt" TIMESTAMP(3),
ADD COLUMN     "smsBlockedSource" TEXT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "providerStatus" TEXT,
ADD COLUMN     "providerStatusAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PhoneNumber" ADD COLUMN     "importedAt" TIMESTAMP(3),
ADD COLUMN     "providerAccountSid" TEXT,
ADD COLUMN     "ringBrowsers" BOOLEAN,
ADD COLUMN     "webhookCheckedAt" TIMESTAMP(3),
ADD COLUMN     "webhookDrift" JSONB;

-- CreateTable
CREATE TABLE "VoiceCall" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "callSid" TEXT NOT NULL,
    "childCallSid" TEXT,
    "accountSid" TEXT NOT NULL,
    "direction" "VoiceCallDirection" NOT NULL,
    "purpose" TEXT,
    "stage" TEXT,
    "phoneNumberId" TEXT,
    "lineE164" TEXT,
    "remoteHash" TEXT,
    "remoteLast4" VARCHAR(4),
    "remoteSecret" JSONB,
    "clientId" TEXT,
    "communicationId" TEXT,
    "callCenterLeadId" TEXT,
    "userId" TEXT,
    "answeredBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'initiated',
    "outcome" "CallOutcome",
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "talkSeconds" INTEGER,
    "recordingSid" TEXT,
    "recordingDurationSeconds" INTEGER,
    "recordingKind" TEXT,
    "recordingExpected" BOOLEAN,
    "disclosureServedAt" TIMESTAMP(3),
    "overrideNonce" TEXT,
    "needsAction" BOOLEAN NOT NULL DEFAULT false,
    "handledAt" TIMESTAMP(3),
    "handledById" TEXT,
    "handledNote" TEXT,
    "errorCode" TEXT,
    "basis" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoicePresence" (
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "identity" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoicePresence_pkey" PRIMARY KEY ("userId","organizationId")
);

-- CreateTable
CREATE TABLE "TelephonyAccountState" (
    "accountSid" TEXT NOT NULL,
    "voiceLimitedMode" TEXT NOT NULL DEFAULT 'auto',
    "voiceLimitedSeenAt" TIMESTAMP(3),
    "profileStatus" TEXT,
    "profileSource" TEXT,
    "balance" TEXT,
    "balanceCurrency" TEXT,
    "mediaAuthState" TEXT,
    "mediaAuthSource" TEXT,
    "mediaAuthCheckedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelephonyAccountState_pkey" PRIMARY KEY ("accountSid")
);

-- CreateIndex
CREATE UNIQUE INDEX "VoiceCall_callSid_key" ON "VoiceCall"("callSid");

-- CreateIndex
CREATE UNIQUE INDEX "VoiceCall_communicationId_key" ON "VoiceCall"("communicationId");

-- CreateIndex
CREATE UNIQUE INDEX "VoiceCall_overrideNonce_key" ON "VoiceCall"("overrideNonce");

-- CreateIndex
CREATE INDEX "VoiceCall_organizationId_needsAction_startedAt_idx" ON "VoiceCall"("organizationId", "needsAction", "startedAt");

-- CreateIndex
CREATE INDEX "VoiceCall_organizationId_startedAt_idx" ON "VoiceCall"("organizationId", "startedAt");

-- CreateIndex
CREATE INDEX "VoiceCall_remoteHash_idx" ON "VoiceCall"("remoteHash");

-- CreateIndex
CREATE INDEX "VoiceCall_clientId_idx" ON "VoiceCall"("clientId");

-- CreateIndex
CREATE INDEX "VoiceCall_callCenterLeadId_idx" ON "VoiceCall"("callCenterLeadId");

-- CreateIndex
CREATE INDEX "VoiceCall_accountSid_status_startedAt_idx" ON "VoiceCall"("accountSid", "status", "startedAt");

-- CreateIndex
CREATE INDEX "VoicePresence_organizationId_lastSeenAt_idx" ON "VoicePresence"("organizationId", "lastSeenAt");

-- CreateIndex
CREATE INDEX "CallCenterLead_organizationId_phoneHash_idx" ON "CallCenterLead"("organizationId", "phoneHash");

-- CreateIndex
CREATE INDEX "Communication_externalRef_idx" ON "Communication"("externalRef");

-- AddForeignKey
ALTER TABLE "VoiceCall" ADD CONSTRAINT "VoiceCall_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
