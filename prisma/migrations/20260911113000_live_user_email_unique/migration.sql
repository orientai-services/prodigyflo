-- User emails must be globally unique among live accounts. A partial index
-- preserves the existing soft-delete semantics: a deleted account's address
-- can be used again by a new workspace owner.
CREATE UNIQUE INDEX "User_live_email_key" ON "User" (LOWER("email")) WHERE "deletedAt" IS NULL;
