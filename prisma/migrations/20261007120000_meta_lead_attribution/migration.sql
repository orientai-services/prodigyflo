-- Additive only: Meta lead source attribution and the out-of-area flag.
-- Existing rows get NULL attribution and outOfArea = false. Nothing is dropped
-- or rewritten.

ALTER TABLE "Client" ADD COLUMN "leadAttribution" JSONB;
ALTER TABLE "Client" ADD COLUMN "outOfArea" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "CallCenterLead" ADD COLUMN "leadAttribution" JSONB;
ALTER TABLE "CallCenterLead" ADD COLUMN "outOfArea" BOOLEAN NOT NULL DEFAULT false;
