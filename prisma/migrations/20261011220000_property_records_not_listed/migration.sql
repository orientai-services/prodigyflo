-- Parcel not yet listed at county: daily retry window and staff-entered APN. Additive, nullable.
ALTER TABLE "PropertyRecordsJob" ADD COLUMN "staffApn" TEXT;
ALTER TABLE "PropertyRecordsJob" ADD COLUMN "notListedSince" TIMESTAMP(3);
