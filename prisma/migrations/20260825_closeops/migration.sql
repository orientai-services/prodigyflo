-- CreateEnum
CREATE TYPE "CoachingKind" AS ENUM ('ONE_ON_ONE', 'CALL_QA');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "aiCloseProbability" INTEGER,
ADD COLUMN     "aiCloseProbabilityAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CloserBrief" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "model" TEXT,
    "content" JSONB NOT NULL DEFAULT '{}',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "viewedAt" TIMESTAMP(3),
    "viewedById" TEXT,

    CONSTRAINT "CloserBrief_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoachingNote" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "kind" "CoachingKind" NOT NULL,
    "clientId" TEXT,
    "callId" TEXT,
    "score" INTEGER,
    "strengths" TEXT,
    "improvements" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoachingNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CloserBrief_organizationId_clientId_generatedAt_idx" ON "CloserBrief"("organizationId", "clientId", "generatedAt");

-- CreateIndex
CREATE INDEX "CoachingNote_organizationId_subjectId_createdAt_idx" ON "CoachingNote"("organizationId", "subjectId", "createdAt");

-- CreateIndex
CREATE INDEX "Client_organizationId_aiCloseProbability_idx" ON "Client"("organizationId", "aiCloseProbability");

-- AddForeignKey
ALTER TABLE "CloserBrief" ADD CONSTRAINT "CloserBrief_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloserBrief" ADD CONSTRAINT "CloserBrief_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloserBrief" ADD CONSTRAINT "CloserBrief_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloserBrief" ADD CONSTRAINT "CloserBrief_viewedById_fkey" FOREIGN KEY ("viewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachingNote" ADD CONSTRAINT "CoachingNote_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachingNote" ADD CONSTRAINT "CoachingNote_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachingNote" ADD CONSTRAINT "CoachingNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachingNote" ADD CONSTRAINT "CoachingNote_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachingNote" ADD CONSTRAINT "CoachingNote_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE SET NULL ON UPDATE CASCADE;
