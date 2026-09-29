-- Additive. Do NOT run against production until the desk is approved.
-- Door 2 Call Center leads. Separate from Client / intake.

CREATE TABLE IF NOT EXISTS "CallCenterLead" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "approachLanguage" TEXT NOT NULL,
  "sourcePageId" TEXT NOT NULL,
  "sourcePageName" TEXT NOT NULL,
  "adName" TEXT,
  "metaLeadgenId" TEXT,
  "name" TEXT NOT NULL,
  "phoneLast4" TEXT NOT NULL,
  "zip" TEXT,
  "queue" TEXT NOT NULL DEFAULT 'new',
  "inbound" BOOLEAN NOT NULL DEFAULT false,
  "note" TEXT,
  "bookedAt" TIMESTAMP(3),
  "lastAction" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "CallCenterLead_metaLeadgenId_key"
  ON "CallCenterLead"("metaLeadgenId")
  WHERE "metaLeadgenId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "CallCenterLead_organizationId_queue_idx"
  ON "CallCenterLead"("organizationId", "queue");

CREATE TABLE IF NOT EXISTS "CallCenterCall" (
  "id" TEXT PRIMARY KEY,
  "leadId" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "recordingUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CallCenterCall_leadId_fkey"
    FOREIGN KEY ("leadId") REFERENCES "CallCenterLead"("id") ON DELETE CASCADE
);
