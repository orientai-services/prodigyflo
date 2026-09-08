import 'server-only'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'

/**
 * Atomic partial writes to `Organization.settings`.
 *
 * The settings column is one JSON blob shared by unrelated features (the
 * closeOps config, the weekly-digest send guard, …). A read-modify-write of
 * the whole blob races: two concurrent writers each replace the full JSON and
 * the loser's sibling keys are silently reverted. Every settings write
 * therefore goes through a single UPDATE that merges ONLY its own top-level
 * subkey inside Postgres, leaving every other key untouched.
 */

/** `settings.<key>` as jsonb — `{}` when the key is missing or not an object. */
function subkeySql(key: string): Prisma.Sql {
  return Prisma.sql`CASE WHEN jsonb_typeof("settings" -> ${key}::text) = 'object' THEN "settings" -> ${key}::text ELSE '{}'::jsonb END`
}

/** SET expression: settings with `patch` shallow-merged into `settings.<key>`. */
function mergedSettingsSql(key: string, patch: Record<string, unknown>): Prisma.Sql {
  return Prisma.sql`CASE WHEN jsonb_typeof("settings") = 'object' THEN "settings" ELSE '{}'::jsonb END || jsonb_build_object(${key}::text, ${subkeySql(key)} || ${JSON.stringify(patch)}::jsonb)`
}

/**
 * Shallow-merge `patch` into `settings.<key>` in one atomic UPDATE. Fields in
 * the patch overwrite same-named fields under the key; sibling top-level keys
 * and unnamed fields under the key are preserved. A `null` field value clears
 * that field to JSON null.
 */
export async function mergeOrgSettings(
  organizationId: string,
  key: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    UPDATE "Organization"
    SET "settings" = ${mergedSettingsSql(key, patch)}, "updatedAt" = NOW()
    WHERE "id" = ${organizationId}`)
}

/**
 * Atomically claim `settings.<key>.<field> = value`: the UPDATE only matches
 * while the field does not already hold `value`, so of any concurrent callers
 * exactly one sees `true`. That winner (and only that winner) may perform the
 * guarded side effect — and may release the claim by merging the field back to
 * `null` if the side effect fails.
 */
export async function claimOrgSettingsValue(
  organizationId: string,
  key: string,
  field: string,
  value: string,
): Promise<boolean> {
  const claimed = await db.$executeRaw(Prisma.sql`
    UPDATE "Organization"
    SET "settings" = ${mergedSettingsSql(key, { [field]: value })}, "updatedAt" = NOW()
    WHERE "id" = ${organizationId}
      AND ("settings" -> ${key}::text ->> ${field}::text) IS DISTINCT FROM ${value}::text`)
  return claimed === 1
}
