-- Additive only: dialer Messages section, lane C (docs/DIALER_APP.md §4).
-- Three nullable columns on CallCenterEvent and two indexes. Nothing is
-- dropped, renamed or made NOT NULL, so it applies on a live table.
--   direction    'in' | 'out' for SMS rows written by Messages; null on every
--                older row (desk trail lines stay as they were)
--   readAt       when an inbound text was opened (unread badges)
--   externalRef  the carrier message id, so a delivery callback finds its
--                row (not unique: the mock carrier repeats ids; an inbound
--                text is made idempotent by its row id instead)

-- AlterTable
ALTER TABLE "CallCenterEvent" ADD COLUMN     "direction" TEXT,
ADD COLUMN     "readAt" TIMESTAMP(3),
ADD COLUMN     "externalRef" TEXT;

-- CreateIndex
CREATE INDEX "CallCenterEvent_externalRef_idx" ON "CallCenterEvent"("externalRef");

-- CreateIndex
CREATE INDEX "CallCenterEvent_type_direction_readAt_idx" ON "CallCenterEvent"("type", "direction", "readAt");
