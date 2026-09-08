-- The wallet backfill in 20260830_telephony created every existing account's
-- wallet with the column default (WALLET), because SQL cannot read
-- TELEPHONY_INTERNAL_SLUGS. That left the internal accounts — the agency and
-- the houses it runs itself — gated on a prepaid balance they will never have,
-- which is the exact opposite of the intended behaviour.
--
-- Correct them here, and ONLY while the wallet has no history: a zero balance
-- and no ledger entry means nothing is being overwritten. ensureWallet() keeps
-- applying the same rule at runtime, so an account added to the internal list
-- later needs no further migration.
UPDATE "TelephonyWallet" w
SET "billingMode" = 'AGENCY_CARD'
FROM "Organization" o
WHERE o."id" = w."organizationId"
  AND w."billingMode" = 'WALLET'
  AND w."balanceCents" = 0
  AND NOT EXISTS (SELECT 1 FROM "WalletEntry" e WHERE e."walletId" = w."id")
  AND (o."kind" = 'AGENCY' OR lower(o."slug") IN ('prodigyflo', 'cys', 'scs'));
