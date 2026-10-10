-- Additive only: Meta Ads reporting for one approved ad account bound to one
-- workspace (docs/META_ADS_SCS.md). New enums, new tables, nullable columns on
-- Campaign and AdSet, and indexes. Nothing is dropped, renamed or rewritten;
-- existing Campaign/AdSet rows get adAccountId = NULL and stay hidden from Meta
-- surfaces until classified.

-- CreateEnum
CREATE TYPE "MetaInsightLevel" AS ENUM ('ACCOUNT', 'CAMPAIGN', 'ADSET', 'AD');

-- CreateEnum
CREATE TYPE "MetaInsightWindow" AS ENUM ('TODAY', 'LAST_7D', 'LAST_30D', 'THIS_MONTH', 'MAXIMUM');

-- CreateEnum
CREATE TYPE "MetaBillingKind" AS ENUM ('PAYMENT', 'STATUS_CHANGE', 'CARD_CHANGE');

-- AlterTable
ALTER TABLE "AdSet" ADD COLUMN     "adAccountId" TEXT,
ADD COLUMN     "effectiveStatus" TEXT,
ADD COLUMN     "lifetimeBudget" DECIMAL(12,2),
ADD COLUMN     "optimizationGoal" TEXT;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "adAccountId" TEXT,
ADD COLUMN     "effectiveStatus" TEXT,
ADD COLUMN     "lifetimeBudget" DECIMAL(12,2),
ADD COLUMN     "metaCreatedAt" TIMESTAMP(3),
ADD COLUMN     "objective" TEXT;

-- CreateTable
CREATE TABLE "MetaAdAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "name" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "timezoneName" TEXT,
    "accountStatus" INTEGER,
    "disableReason" INTEGER,
    "balanceCents" BIGINT,
    "amountSpentCents" BIGINT,
    "spendCapCents" BIGINT,
    "fundingDisplay" TEXT,
    "fundingType" INTEGER,
    "pendingCharge" JSONB,
    "billingVersion" INTEGER NOT NULL DEFAULT 0,
    "lastReadingAt" TIMESTAMP(3),
    "cycleDays" INTEGER NOT NULL DEFAULT 15,
    "syncLeaseUntil" TIMESTAMP(3),
    "syncLeaseOwner" TEXT,
    "lastManualRefreshAt" TIMESTAMP(3),
    "lastSnapshotAt" TIMESTAMP(3),
    "lastFullSyncAt" TIMESTAMP(3),
    "lastConnectionCheckAt" TIMESTAMP(3),
    "backoffUntil" TIMESTAMP(3),
    "lastUsagePct" INTEGER,
    "lastTruncated" BOOLEAN NOT NULL DEFAULT false,
    "lastErrorKind" TEXT,
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "tokenValid" BOOLEAN,
    "tokenExpiresAt" TIMESTAMP(3),
    "tokenAppId" TEXT,
    "tokenType" TEXT,
    "tokenScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tokenSeesOthers" BOOLEAN NOT NULL DEFAULT false,
    "tokenTargetsOk" BOOLEAN,
    "leadOrgMatches" BOOLEAN,
    "outsideLeadCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaAdAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaAd" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adSetId" TEXT,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "effectiveStatus" TEXT,
    "removed" BOOLEAN NOT NULL DEFAULT false,
    "formId" TEXT,
    "thumbnailUrl" TEXT,
    "headline" TEXT,
    "body" TEXT,
    "cta" TEXT,
    "linkUrl" TEXT,
    "metaCreatedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaAd_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaObjectAccount" (
    "objectId" TEXT NOT NULL,
    "adAccountId" TEXT,
    "outside" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetaObjectAccount_pkey" PRIMARY KEY ("objectId")
);

-- CreateTable
CREATE TABLE "MetaInsightDaily" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "level" "MetaInsightLevel" NOT NULL,
    "objectId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "spend" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "reach" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "linkClicks" INTEGER NOT NULL DEFAULT 0,
    "leads" INTEGER NOT NULL DEFAULT 0,
    "landingPageViews" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaInsightDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaInsightSummary" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "level" "MetaInsightLevel" NOT NULL,
    "objectId" TEXT NOT NULL,
    "window" "MetaInsightWindow" NOT NULL,
    "spend" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "reach" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "linkClicks" INTEGER NOT NULL DEFAULT 0,
    "leads" INTEGER NOT NULL DEFAULT 0,
    "landingPageViews" INTEGER NOT NULL DEFAULT 0,
    "frequency" DECIMAL(8,3),
    "dateStart" DATE,
    "dateStop" DATE,
    "partial" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaInsightSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaAccountSnapshot" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "balanceCents" BIGINT,
    "amountSpentCents" BIGINT,
    "spendCapCents" BIGINT,
    "accountStatus" INTEGER,
    "fundingDisplay" TEXT,
    "fundingType" INTEGER,
    "stale" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MetaAccountSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaBillingEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "kind" "MetaBillingKind" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "fromSnapshotId" TEXT NOT NULL,
    "amountCents" BIGINT,
    "approximate" BOOLEAN NOT NULL DEFAULT true,
    "before" TEXT,
    "after" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetaBillingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaSpendCycle" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "lengthDays" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "startedById" TEXT,
    "startDayExcludedSpend" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "spendApproximate" BOOLEAN NOT NULL DEFAULT false,
    "closedSpend" DECIMAL(12,2),
    "closedLeads" INTEGER,
    "finalAfter" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetaSpendCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaLeadTouch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "leadgenId" TEXT NOT NULL,
    "adAccountId" TEXT,
    "adId" TEXT,
    "adSetId" TEXT,
    "campaignId" TEXT,
    "formId" TEXT,
    "platform" TEXT,
    "isOrganic" BOOLEAN,
    "status" TEXT NOT NULL,
    "clientId" TEXT,
    "callCenterLeadId" TEXT,
    "leadCreatedAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaLeadTouch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MetaAdAccount_adAccountId_key" ON "MetaAdAccount"("adAccountId");

-- CreateIndex
CREATE INDEX "MetaAdAccount_organizationId_idx" ON "MetaAdAccount"("organizationId");

-- CreateIndex
CREATE INDEX "MetaAd_organizationId_adAccountId_idx" ON "MetaAd"("organizationId", "adAccountId");

-- CreateIndex
CREATE INDEX "MetaAd_campaignId_idx" ON "MetaAd"("campaignId");

-- CreateIndex
CREATE INDEX "MetaAd_adSetId_idx" ON "MetaAd"("adSetId");

-- CreateIndex
CREATE UNIQUE INDEX "MetaAd_organizationId_externalId_key" ON "MetaAd"("organizationId", "externalId");

-- CreateIndex
CREATE INDEX "MetaInsightDaily_organizationId_adAccountId_level_date_idx" ON "MetaInsightDaily"("organizationId", "adAccountId", "level", "date");

-- CreateIndex
CREATE UNIQUE INDEX "MetaInsightDaily_organizationId_level_objectId_date_key" ON "MetaInsightDaily"("organizationId", "level", "objectId", "date");

-- CreateIndex
CREATE INDEX "MetaInsightSummary_organizationId_adAccountId_window_idx" ON "MetaInsightSummary"("organizationId", "adAccountId", "window");

-- CreateIndex
CREATE UNIQUE INDEX "MetaInsightSummary_organizationId_level_objectId_window_key" ON "MetaInsightSummary"("organizationId", "level", "objectId", "window");

-- CreateIndex
CREATE INDEX "MetaAccountSnapshot_organizationId_adAccountId_takenAt_idx" ON "MetaAccountSnapshot"("organizationId", "adAccountId", "takenAt");

-- CreateIndex
CREATE INDEX "MetaBillingEvent_organizationId_adAccountId_occurredAt_idx" ON "MetaBillingEvent"("organizationId", "adAccountId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "MetaBillingEvent_adAccountId_kind_fromSnapshotId_key" ON "MetaBillingEvent"("adAccountId", "kind", "fromSnapshotId");

-- CreateIndex
CREATE INDEX "MetaSpendCycle_organizationId_adAccountId_endedAt_idx" ON "MetaSpendCycle"("organizationId", "adAccountId", "endedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MetaSpendCycle_adAccountId_number_key" ON "MetaSpendCycle"("adAccountId", "number");

-- CreateIndex
CREATE INDEX "MetaLeadTouch_organizationId_adId_idx" ON "MetaLeadTouch"("organizationId", "adId");

-- CreateIndex
CREATE INDEX "MetaLeadTouch_organizationId_status_idx" ON "MetaLeadTouch"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MetaLeadTouch_organizationId_leadgenId_key" ON "MetaLeadTouch"("organizationId", "leadgenId");

-- CreateIndex
CREATE INDEX "AdSet_organizationId_adAccountId_idx" ON "AdSet"("organizationId", "adAccountId");

-- CreateIndex
CREATE INDEX "Campaign_organizationId_adAccountId_idx" ON "Campaign"("organizationId", "adAccountId");

-- AddForeignKey
ALTER TABLE "MetaAdAccount" ADD CONSTRAINT "MetaAdAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaAd" ADD CONSTRAINT "MetaAd_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaInsightDaily" ADD CONSTRAINT "MetaInsightDaily_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaInsightSummary" ADD CONSTRAINT "MetaInsightSummary_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaAccountSnapshot" ADD CONSTRAINT "MetaAccountSnapshot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaBillingEvent" ADD CONSTRAINT "MetaBillingEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaSpendCycle" ADD CONSTRAINT "MetaSpendCycle_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaLeadTouch" ADD CONSTRAINT "MetaLeadTouch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
