-- Additive only: two read indexes on CallCenterEvent for the dialer's lists.
-- Nothing is dropped or changed, so it applies on a live database.
--
-- (type, createdAt): Messages threads, History "Calls & SMS" texts and the
-- Today team feed read SMS/OUTCOME rows newest first.
-- (createdAt): History > Activity reads several event types newest first.
--
-- Plain CREATE INDEX briefly blocks writes to CallCenterEvent while it builds.
-- To avoid that on a large table, run the same statements with CONCURRENTLY
-- by hand first; IF NOT EXISTS then makes this migration a no-op.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CallCenterEvent_type_createdAt_idx" ON "CallCenterEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CallCenterEvent_createdAt_idx" ON "CallCenterEvent"("createdAt");
