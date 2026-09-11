-- Route an intake source into a shared team queue without assigning a person.
ALTER TABLE "IntakeSource" ADD COLUMN "defaultTeamId" TEXT;

CREATE INDEX "IntakeSource_defaultTeamId_idx" ON "IntakeSource"("defaultTeamId");

ALTER TABLE "IntakeSource"
  ADD CONSTRAINT "IntakeSource_defaultTeamId_fkey"
  FOREIGN KEY ("defaultTeamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
