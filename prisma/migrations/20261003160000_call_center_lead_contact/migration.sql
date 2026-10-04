-- Additive contact secrets. Does not change the earlier Call Center migration.
-- The values are encryptSecret blobs. The list keeps phoneLast4 only.

ALTER TABLE "CallCenterLead" ADD COLUMN "phoneSecret" JSONB;
ALTER TABLE "CallCenterLead" ADD COLUMN "emailSecret" JSONB;
