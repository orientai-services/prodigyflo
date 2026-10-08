-- Additive: records when a spend cycle's start-day split was worked out from
-- Meta's hourly breakdown. Cycles already past the 48 h retry window keep their
-- current label (treated as worked out); younger ones are settled by the sync.
ALTER TABLE "MetaSpendCycle" ADD COLUMN "startDayExcludedAt" TIMESTAMP(3);

UPDATE "MetaSpendCycle"
SET "startDayExcludedAt" = "createdAt"
WHERE "spendApproximate" = false AND "startedAt" < now() - interval '48 hours';
