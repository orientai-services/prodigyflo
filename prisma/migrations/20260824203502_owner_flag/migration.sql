-- AlterTable
ALTER TABLE "Invite" ADD COLUMN     "isOwner" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isOwner" BOOLEAN NOT NULL DEFAULT false;
