-- CreateEnum
CREATE TYPE "CallRouting" AS ENUM ('FORWARD', 'TEAM', 'VOICEMAIL_ONLY');

-- CreateEnum
CREATE TYPE "PhoneNumberKind" AS ENUM ('LOCAL', 'TOLL_FREE');

-- CreateEnum
CREATE TYPE "PhoneNumberStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'RELEASED');

-- CreateEnum
CREATE TYPE "TelephonyBilling" AS ENUM ('WALLET', 'AGENCY_CARD');

-- CreateEnum
CREATE TYPE "WalletEntryKind" AS ENUM ('TOPUP', 'NUMBER_SETUP', 'NUMBER_MONTHLY', 'USAGE_SMS', 'USAGE_VOICE', 'REFUND', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "PhoneNumber" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "e164" TEXT NOT NULL,
    "friendlyName" TEXT NOT NULL,
    "kind" "PhoneNumberKind" NOT NULL DEFAULT 'LOCAL',
    "status" "PhoneNumberStatus" NOT NULL DEFAULT 'PENDING',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "areaCode" TEXT,
    "region" TEXT,
    "locality" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "providerSid" TEXT,
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "routing" "CallRouting" NOT NULL DEFAULT 'VOICEMAIL_ONLY',
    "forwardTo" TEXT,
    "teamUserIds" JSONB NOT NULL DEFAULT '[]',
    "voicemailGreeting" TEXT,
    "recordCalls" BOOLEAN NOT NULL DEFAULT false,
    "assignedUserId" TEXT,
    "billingMode" "TelephonyBilling" NOT NULL DEFAULT 'WALLET',
    "monthlyCostCents" INTEGER NOT NULL DEFAULT 0,
    "setupCostCents" INTEGER NOT NULL DEFAULT 0,
    "nextRenewalAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhoneNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelephonyWallet" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "balanceCents" INTEGER NOT NULL DEFAULT 0,
    "billingMode" "TelephonyBilling" NOT NULL DEFAULT 'WALLET',
    "reserveCents" INTEGER NOT NULL DEFAULT 0,
    "autoReloadEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoReloadThresholdCents" INTEGER NOT NULL DEFAULT 1000,
    "autoReloadAmountCents" INTEGER NOT NULL DEFAULT 2500,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelephonyWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "kind" "WalletEntryKind" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "balanceAfterCents" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "phoneNumberId" TEXT,
    "externalRef" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PhoneNumber_e164_key" ON "PhoneNumber"("e164");

-- CreateIndex
CREATE INDEX "PhoneNumber_organizationId_status_idx" ON "PhoneNumber"("organizationId", "status");

-- CreateIndex
CREATE INDEX "PhoneNumber_nextRenewalAt_idx" ON "PhoneNumber"("nextRenewalAt");

-- CreateIndex
CREATE UNIQUE INDEX "TelephonyWallet_organizationId_key" ON "TelephonyWallet"("organizationId");

-- CreateIndex
CREATE INDEX "WalletEntry_organizationId_createdAt_idx" ON "WalletEntry"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "WalletEntry_walletId_createdAt_idx" ON "WalletEntry"("walletId", "createdAt");

-- AddForeignKey
ALTER TABLE "PhoneNumber" ADD CONSTRAINT "PhoneNumber_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneNumber" ADD CONSTRAINT "PhoneNumber_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneNumber" ADD CONSTRAINT "PhoneNumber_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelephonyWallet" ADD CONSTRAINT "TelephonyWallet_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletEntry" ADD CONSTRAINT "WalletEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletEntry" ADD CONSTRAINT "WalletEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "TelephonyWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletEntry" ADD CONSTRAINT "WalletEntry_phoneNumberId_fkey" FOREIGN KEY ("phoneNumberId") REFERENCES "PhoneNumber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletEntry" ADD CONSTRAINT "WalletEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Data: the two telephony permissions, granted to every existing system
-- ── SUPER_ADMIN and ADMIN role in every org. bootstrapOrganization() does the
-- ── same for accounts created later; this covers the ones that already exist.
INSERT INTO "Permission" ("id", "key", "description", "category")
VALUES
  ('perm_telephony_read', 'telephony:read', 'View phone numbers and the telephony wallet', 'Administration'),
  ('perm_telephony_manage', 'telephony:manage', 'Buy, configure, and release phone numbers', 'Administration')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r."key" IN ('SUPER_ADMIN', 'ADMIN')
  AND p."key" IN ('telephony:read', 'telephony:manage')
ON CONFLICT DO NOTHING;

-- Sales managers may see the account's lines (read-only) so they know which
-- number their team calls from; they cannot buy or release.
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r."key" IN ('REGIONAL_MANAGER', 'SALES_MANAGER')
  AND p."key" = 'telephony:read'
ON CONFLICT DO NOTHING;

-- Every existing organization gets a wallet row so the console never renders
-- an account without one. Internal accounts are switched to AGENCY_CARD by the
-- application (TELEPHONY_INTERNAL_SLUGS), not here.
INSERT INTO "TelephonyWallet" ("id", "organizationId", "createdAt", "updatedAt")
SELECT 'twal_' || o."id", o."id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Organization" o
WHERE o."deletedAt" IS NULL
ON CONFLICT ("organizationId") DO NOTHING;
