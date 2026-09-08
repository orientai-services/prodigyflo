-- AlterEnum
ALTER TYPE "IntakeSourceKind" ADD VALUE 'META_LEAD_ADS';

-- CreateTable
CREATE TABLE "CampaignDailyStat" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "spend" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "leads" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignDailyStat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignDailyStat_campaignId_idx" ON "CampaignDailyStat"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignDailyStat_campaignId_date_key" ON "CampaignDailyStat"("campaignId", "date");

-- AddForeignKey
ALTER TABLE "CampaignDailyStat" ADD CONSTRAINT "CampaignDailyStat_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
