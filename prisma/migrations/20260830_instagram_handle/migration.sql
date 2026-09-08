-- AlterTable
ALTER TABLE "Client" ADD COLUMN "instagramUserId" TEXT;
ALTER TABLE "Client" ADD COLUMN "instagramHandle" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Client_organizationId_instagramUserId_key" ON "Client"("organizationId", "instagramUserId");
