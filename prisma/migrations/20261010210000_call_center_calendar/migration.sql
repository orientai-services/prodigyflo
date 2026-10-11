-- CreateEnum
CREATE TYPE "CallCenterSlotStatus" AS ENUM ('HOLD', 'CONFIRMED', 'SAT', 'NO_SHOW', 'RESCHEDULED', 'CANCELLED');

-- CreateTable
CREATE TABLE "CallCenterSlot" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "repKey" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "CallCenterSlotStatus" NOT NULL DEFAULT 'HOLD',
    "language" "CallCenterLeadLanguage" NOT NULL DEFAULT 'EN',
    "heldBy" TEXT NOT NULL DEFAULT 'rep',
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "outcomeAt" TIMESTAMP(3),
    "rescheduledToId" TEXT,
    "reminder24RepAt" TIMESTAMP(3),
    "reminder24ClientAt" TIMESTAMP(3),
    "reminder3RepAt" TIMESTAMP(3),
    "reminder3ClientAt" TIMESTAMP(3),
    "reminderError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallCenterSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallCenterRepHours" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "repKey" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL DEFAULT 540,
    "endMinute" INTEGER NOT NULL DEFAULT 1050,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallCenterRepHours_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CallCenterSlot_organizationId_repKey_startsAt_idx" ON "CallCenterSlot"("organizationId", "repKey", "startsAt");

-- CreateIndex
CREATE INDEX "CallCenterSlot_leadId_idx" ON "CallCenterSlot"("leadId");

-- CreateIndex
CREATE INDEX "CallCenterSlot_status_startsAt_idx" ON "CallCenterSlot"("status", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "CallCenterRepHours_organizationId_repKey_weekday_key" ON "CallCenterRepHours"("organizationId", "repKey", "weekday");

-- AddForeignKey
ALTER TABLE "CallCenterSlot" ADD CONSTRAINT "CallCenterSlot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallCenterSlot" ADD CONSTRAINT "CallCenterSlot_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "CallCenterLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallCenterRepHours" ADD CONSTRAINT "CallCenterRepHours_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

