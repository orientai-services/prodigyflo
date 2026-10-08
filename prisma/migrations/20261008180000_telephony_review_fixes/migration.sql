-- Additive only: fixes from the telephony live review (docs/TELEPHONY_LIVE.md).
-- Three nullable columns and one unique index. Nothing is dropped, renamed or
-- made NOT NULL. Existing rows keep NULL in every new column, and Postgres
-- unique indexes ignore NULLs, so no existing row can conflict.

-- AlterTable
ALTER TABLE "CallCenterEvent" ADD COLUMN     "voiceCallId" TEXT;

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "timeZone" TEXT;

-- AlterTable
ALTER TABLE "VoiceCall" ADD COLUMN     "stirVerstat" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "CallCenterEvent_voiceCallId_type_key" ON "CallCenterEvent"("voiceCallId", "type");
