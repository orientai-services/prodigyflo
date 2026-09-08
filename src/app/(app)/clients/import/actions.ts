'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { createClientRecord, updateClientRecord } from '@/lib/clients'
import { MAX_IMPORT_ROWS, validateRecord, type ImportRecord } from '@/lib/csv'
import { mergeIncoming, normaliseEmail, normalisePhone } from '@/lib/dedupe'
import { ForbiddenError, requirePermission, type SessionUser } from '@/lib/rbac'

const recordSchema = z.record(z.string(), z.string().max(1000))
const rowsSchema = z.object({
  records: z.array(recordSchema).min(1, 'The file has no data rows.').max(MAX_IMPORT_ROWS),
  fileName: z.string().trim().max(200).default('import.csv'),
})

export type RowStatus =
  | { kind: 'new' }
  | { kind: 'update'; clientId: string; matchName: string; matchedOn: 'email' | 'phone' }
  | { kind: 'invalid'; errors: string[] }

export type AnalyzeResult = {
  ok?: boolean
  error?: string
  statuses?: RowStatus[]
  counts?: { new: number; update: number; invalid: number }
}

/**
 * Classifies every mapped row against the database in one pass: one bulk
 * candidate query, then in-JS matching on normalised email/phone. Rows that
 * duplicate an earlier row in the same file collapse onto that row's identity.
 */
async function classifyRows(user: SessionUser, records: ImportRecord[]): Promise<RowStatus[]> {
  const emails = [...new Set(records.map((r) => normaliseEmail(r.email)).filter(Boolean))]
  const phones = [...new Set(records.map((r) => normalisePhone(r.phone)).filter((p) => p.length >= 4))]

  const or: object[] = [
    ...emails.map((e) => ({ email: { equals: e, mode: 'insensitive' as const } })),
    ...phones.map((p) => ({ phone: { contains: p.slice(-4) } })),
  ]

  const candidates = or.length
    ? await db.client.findMany({
        where: { organizationId: user.organizationId, deletedAt: null, OR: or },
        select: { id: true, firstName: true, lastName: true, email: true, phone: true },
      })
    : []

  const byEmail = new Map<string, (typeof candidates)[number]>()
  const byPhone = new Map<string, (typeof candidates)[number]>()
  for (const c of candidates) {
    const e = normaliseEmail(c.email)
    const p = normalisePhone(c.phone)
    if (e && !byEmail.has(e)) byEmail.set(e, c)
    if (p && !byPhone.has(p)) byPhone.set(p, c)
  }

  const seenEmails = new Set<string>()
  const seenPhones = new Set<string>()

  return records.map((record): RowStatus => {
    const errors = validateRecord(record)
    if (errors.length > 0) return { kind: 'invalid', errors }

    const email = normaliseEmail(record.email)
    const phone = normalisePhone(record.phone)

    const emailMatch = email ? byEmail.get(email) : undefined
    if (emailMatch) {
      return {
        kind: 'update',
        clientId: emailMatch.id,
        matchName: `${emailMatch.firstName} ${emailMatch.lastName}`,
        matchedOn: 'email',
      }
    }
    const phoneMatch = phone ? byPhone.get(phone) : undefined
    if (phoneMatch) {
      return {
        kind: 'update',
        clientId: phoneMatch.id,
        matchName: `${phoneMatch.firstName} ${phoneMatch.lastName}`,
        matchedOn: 'phone',
      }
    }

    // Same identity earlier in this very file — importable, but not twice.
    if ((email && seenEmails.has(email)) || (phone && seenPhones.has(phone))) {
      return { kind: 'invalid', errors: ['Duplicates an earlier row in this file'] }
    }
    if (email) seenEmails.add(email)
    if (phone) seenPhones.add(phone)
    return { kind: 'new' }
  })
}

export async function analyzeImportAction(input: unknown): Promise<AnalyzeResult> {
  const parsed = rowsSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input.' }

  try {
    const user = await requirePermission('clients:create')
    const statuses = await classifyRows(user, parsed.data.records as ImportRecord[])
    return {
      ok: true,
      statuses,
      counts: {
        new: statuses.filter((s) => s.kind === 'new').length,
        update: statuses.filter((s) => s.kind === 'update').length,
        invalid: statuses.filter((s) => s.kind === 'invalid').length,
      },
    }
  } catch (error) {
    if (error instanceof ForbiddenError) return { error: error.message }
    throw error
  }
}

export type CommitResult = {
  ok?: boolean
  error?: string
  created?: number
  updated?: number
  unchanged?: number
  skipped?: number
}

export async function commitImportAction(input: unknown): Promise<CommitResult> {
  const parsed = rowsSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input.' }
  const { fileName } = parsed.data
  const records = parsed.data.records as ImportRecord[]

  try {
    const user = await requirePermission('clients:create')

    // Never trust the preview the browser sent back — classify again.
    const statuses = await classifyRows(user, records)

    const sourceCache = new Map<string, string | null>()
    const leadSourceId = async (name: string | undefined): Promise<string | null> => {
      if (!name) return null
      const key = name.trim().toLowerCase()
      if (!sourceCache.has(key)) {
        const found = await db.leadSource.findFirst({
          where: { organizationId: user.organizationId, name: { equals: name.trim(), mode: 'insensitive' } },
          select: { id: true },
        })
        sourceCache.set(key, found?.id ?? null)
      }
      return sourceCache.get(key) ?? null
    }

    let created = 0
    let updated = 0
    let unchanged = 0
    let skipped = 0

    for (let i = 0; i < records.length; i++) {
      const record = records[i]
      const status = statuses[i]

      if (status.kind === 'invalid') {
        skipped++
        continue
      }

      const value = record.estimatedValue ? Number(record.estimatedValue.replace(/[$,]/g, '')) : null

      if (status.kind === 'new') {
        await createClientRecord(
          user,
          {
            firstName: record.firstName!,
            lastName: record.lastName!,
            email: record.email ?? '',
            phone: record.phone ?? '',
            preferredLanguage: record.preferredLanguage,
            leadSourceId: await leadSourceId(record.leadSource),
            estimatedValue: value,
            utmSource: record.utmSource ?? null,
            utmMedium: record.utmMedium ?? null,
            utmCampaign: record.utmCampaign ?? null,
            address:
              record.line1 && record.city && record.state && record.postalCode
                ? {
                    line1: record.line1,
                    line2: record.line2 ?? null,
                    city: record.city,
                    state: record.state,
                    postalCode: record.postalCode,
                  }
                : null,
            note: record.note ?? null,
          },
          `csv-import (${fileName})`,
        )
        created++
        continue
      }

      // Merge-update an existing client. Empty incoming values never erase data.
      const existing = await db.client.findFirst({
        where: { id: status.clientId, organizationId: user.organizationId, deletedAt: null },
      })
      if (!existing) {
        skipped++
        continue
      }

      const incoming = {
        firstName: record.firstName ?? '',
        lastName: record.lastName ?? '',
        email: normaliseEmail(record.email),
        phone: normalisePhone(record.phone),
        preferredLanguage: record.preferredLanguage ?? '',
        utmSource: record.utmSource ?? '',
        utmMedium: record.utmMedium ?? '',
        utmCampaign: record.utmCampaign ?? '',
      }
      const base = {
        firstName: existing.firstName,
        lastName: existing.lastName,
        email: existing.email,
        phone: existing.phone,
        preferredLanguage: existing.preferredLanguage,
        utmSource: existing.utmSource ?? '',
        utmMedium: existing.utmMedium ?? '',
        utmCampaign: existing.utmCampaign ?? '',
      }
      const changes: Record<string, unknown> = mergeIncoming(base, incoming)

      if (value !== null && Number.isFinite(value) && existing.estimatedValue === null) {
        changes.estimatedValue = value
      }
      if (!existing.leadSourceId) {
        const sid = await leadSourceId(record.leadSource)
        if (sid) changes.leadSourceId = sid
      }

      if (Object.keys(changes).length === 0) {
        unchanged++
        continue
      }

      await updateClientRecord(
        user,
        existing.id,
        changes,
        `Merged CSV row from ${fileName} (matched on ${status.matchedOn})`,
        base,
      )
      updated++
    }

    await recordAudit(user, {
      action: 'clients.import_completed',
      entityType: 'Client',
      summary: `CSV import ${fileName}: ${created} created, ${updated} updated, ${unchanged} unchanged, ${skipped} skipped`,
      after: { fileName, rowCount: records.length, created, updated, unchanged, skipped },
    })

    revalidatePath('/clients')
    return { ok: true, created, updated, unchanged, skipped }
  } catch (error) {
    if (error instanceof ForbiddenError) return { error: error.message }
    throw error
  }
}
