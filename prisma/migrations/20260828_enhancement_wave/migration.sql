-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "spendCap" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "CampaignDailyStat" ADD COLUMN     "adSetId" TEXT;

-- CreateTable
CREATE TABLE "ConnectorCredential" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "last4" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectorCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdSet" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "externalId" TEXT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "dailyBudget" DECIMAL(12,2),
    "spend" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngineRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,
    "stats" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EngineRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngineStep" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "dependsOn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),

    CONSTRAINT "EngineStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Insight" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "runId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "score" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "outcome" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Insight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeployRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "startedById" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "commitHash" TEXT,
    "logPath" TEXT,
    "summary" TEXT,

    CONSTRAINT "DeployRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConnectorCredential_organizationId_idx" ON "ConnectorCredential"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectorCredential_connectorId_fieldKey_key" ON "ConnectorCredential"("connectorId", "fieldKey");

-- CreateIndex
CREATE INDEX "AdSet_campaignId_idx" ON "AdSet"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "AdSet_organizationId_externalId_key" ON "AdSet"("organizationId", "externalId");

-- CreateIndex
CREATE INDEX "EngineRun_organizationId_status_idx" ON "EngineRun"("organizationId", "status");

-- CreateIndex
CREATE INDEX "EngineStep_runId_status_idx" ON "EngineStep"("runId", "status");

-- CreateIndex
CREATE INDEX "EngineStep_status_nextRunAt_idx" ON "EngineStep"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "Insight_organizationId_status_createdAt_idx" ON "Insight"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "DeployRun_organizationId_startedAt_idx" ON "DeployRun"("organizationId", "startedAt");

-- CreateIndex
CREATE INDEX "CampaignDailyStat_adSetId_idx" ON "CampaignDailyStat"("adSetId");

-- AddForeignKey
ALTER TABLE "ConnectorCredential" ADD CONSTRAINT "ConnectorCredential_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectorCredential" ADD CONSTRAINT "ConnectorCredential_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectorCredential" ADD CONSTRAINT "ConnectorCredential_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdSet" ADD CONSTRAINT "AdSet_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdSet" ADD CONSTRAINT "AdSet_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngineRun" ADD CONSTRAINT "EngineRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngineStep" ADD CONSTRAINT "EngineStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EngineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Insight" ADD CONSTRAINT "Insight_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Insight" ADD CONSTRAINT "Insight_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EngineRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Insight" ADD CONSTRAINT "Insight_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeployRun" ADD CONSTRAINT "DeployRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeployRun" ADD CONSTRAINT "DeployRun_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
