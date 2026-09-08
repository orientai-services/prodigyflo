-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailAlias" TEXT,
ADD COLUMN     "forwardingEmail" TEXT,
ADD COLUMN     "forwardingStatus" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "nickname" TEXT,
ADD COLUMN     "signatureIncludePhone" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "signatureStyle" TEXT NOT NULL DEFAULT 'formal';

-- CreateIndex
CREATE UNIQUE INDEX "User_organizationId_emailAlias_key" ON "User"("organizationId", "emailAlias");
