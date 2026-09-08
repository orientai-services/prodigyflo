-- CreateEnum
CREATE TYPE "IntakeAuthMode" AS ENUM ('HMAC', 'TOKEN');

-- AlterTable
ALTER TABLE "IntakeSource" ADD COLUMN     "authMode" "IntakeAuthMode" NOT NULL DEFAULT 'HMAC';
