-- Additive only: caps automation retries when the calling-rules check can't
-- run (docs/TELEPHONY_LIVE.md). One nullable column. Nothing is dropped,
-- renamed or made NOT NULL; existing rows keep NULL (= no failed checks yet).

-- AlterTable
ALTER TABLE "SequenceEnrollment" ADD COLUMN     "attempts" INTEGER;
