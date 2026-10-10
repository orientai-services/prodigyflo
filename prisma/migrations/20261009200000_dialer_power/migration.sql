-- Additive only: dialer power-up, Lane C (docs/DIALER_POWER.md).
-- Five new columns: one with a constant default (Postgres 11+ adds it without
-- a table rewrite), four nullable. Nothing is dropped, renamed or made NOT
-- NULL on existing data, and no index is added, so it applies instantly on a
-- live table.

-- AlterTable
ALTER TABLE "VoiceCall" ADD COLUMN     "callbackRequested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "transcript" TEXT,
ADD COLUMN     "handledDisposition" TEXT;

-- AlterTable
ALTER TABLE "CallCenterLead" ADD COLUMN     "speedAlertedAt" TIMESTAMP(3),
ADD COLUMN     "speedEscalatedAt" TIMESTAMP(3);
