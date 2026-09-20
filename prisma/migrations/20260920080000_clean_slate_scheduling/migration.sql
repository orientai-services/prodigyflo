CREATE TABLE "AppointmentReceipt" (
  "id" TEXT PRIMARY KEY,
  "clientId" TEXT NOT NULL REFERENCES "Client"("id") ON DELETE CASCADE,
  "appointmentId" TEXT REFERENCES "Appointment"("id") ON DELETE SET NULL,
  "outcome" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AppointmentReceipt_clientId_idx" ON "AppointmentReceipt"("clientId");
CREATE TABLE "RetiredIdentity" (
  "id" TEXT PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
