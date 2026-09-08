-- AlterEnum
-- Postgres 12+ allows ADD VALUE inside a transaction as long as the new value
-- is not used in the same transaction (matches 20260826_connectors' pattern).
ALTER TYPE "ConnectorKind" ADD VALUE 'GO_HIGH_LEVEL';

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'CLIENT',
ADD COLUMN     "parentOrganizationId" TEXT;

-- CreateIndex
CREATE INDEX "Organization_parentOrganizationId_idx" ON "Organization"("parentOrganizationId");

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_parentOrganizationId_fkey" FOREIGN KEY ("parentOrganizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
