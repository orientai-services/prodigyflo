-- An intake appointment can exist before a Super Admin assigns its client.
ALTER TABLE "Appointment" ALTER COLUMN "ownerId" DROP NOT NULL;
ALTER TABLE "Appointment" DROP CONSTRAINT "Appointment_ownerId_fkey";
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
