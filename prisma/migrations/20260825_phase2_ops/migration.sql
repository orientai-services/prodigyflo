-- CreateEnum
CREATE TYPE "NurtureKind" AS ENUM ('VIDEO', 'EMAIL', 'SMS', 'CALL_PREP');

-- CreateEnum
CREATE TYPE "HotLeadDecision" AS ENUM ('APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "adherence" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "NurtureTouch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "kind" "NurtureKind" NOT NULL DEFAULT 'VIDEO',
    "url" TEXT,
    "note" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "NurtureTouch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HotLeadReview" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "decision" "HotLeadDecision" NOT NULL,
    "reason" TEXT,
    "probabilityAtReview" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HotLeadReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NurtureTouch_organizationId_clientId_sentAt_idx" ON "NurtureTouch"("organizationId", "clientId", "sentAt");

-- CreateIndex
CREATE INDEX "HotLeadReview_organizationId_clientId_createdAt_idx" ON "HotLeadReview"("organizationId", "clientId", "createdAt");

-- CreateIndex
CREATE INDEX "HotLeadReview_organizationId_decision_idx" ON "HotLeadReview"("organizationId", "decision");

-- AddForeignKey
ALTER TABLE "NurtureTouch" ADD CONSTRAINT "NurtureTouch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NurtureTouch" ADD CONSTRAINT "NurtureTouch_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NurtureTouch" ADD CONSTRAINT "NurtureTouch_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotLeadReview" ADD CONSTRAINT "HotLeadReview_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotLeadReview" ADD CONSTRAINT "HotLeadReview_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotLeadReview" ADD CONSTRAINT "HotLeadReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
