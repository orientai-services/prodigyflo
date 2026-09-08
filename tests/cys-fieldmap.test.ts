import { describe, expect, it } from 'vitest'
import { STARTER_FIELDS } from '../prisma/seeds/cys'
import { DOC_TYPE_SPECS } from '@/lib/extraction/spec'

/**
 * The CYS field map and the extraction spec are built independently, so a
 * DOCUMENT_FIELD source path can silently name a key the extractor never emits.
 * When that happens on a required field, it can never be filled and CYS
 * approval is blocked forever — with nothing in the UI explaining why.
 */
describe('CYS starter map ↔ extraction spec', () => {
  const emitted = new Map(
    DOC_TYPE_SPECS.map((spec) => [spec.key, new Set(spec.fields.map((f) => f.key))]),
  )

  const documentFields = STARTER_FIELDS.filter((f) => f.sourceType === 'DOCUMENT_FIELD')

  it('has document-sourced fields to check', () => {
    expect(documentFields.length).toBeGreaterThan(0)
  })

  it.each(documentFields.map((f) => [f.key, f.sourcePath] as const))(
    'resolves %s -> %s to a real extracted field',
    (_key, sourcePath) => {
      const parts = String(sourcePath).split('.')
      expect(parts[0]).toBe('document')

      // document.<typeKey>.<fieldKey> — the any-type form (document.<fieldKey>)
      // is checked against the union of every spec instead.
      if (parts.length === 3) {
        const [, typeKey, fieldKey] = parts
        expect(emitted.has(typeKey), `unknown document type "${typeKey}"`).toBe(true)
        expect(
          emitted.get(typeKey)!.has(fieldKey),
          `"${typeKey}" emits [${[...emitted.get(typeKey)!].join(', ')}], not "${fieldKey}"`,
        ).toBe(true)
      } else {
        const all = new Set([...emitted.values()].flatMap((s) => [...s]))
        expect(all.has(parts[1]), `no document type emits "${parts[1]}"`).toBe(true)
      }
    },
  )

  it('every required field is fillable from some source', () => {
    for (const f of STARTER_FIELDS.filter((x) => x.isRequired)) {
      if (f.sourceType === 'MANUAL') continue
      expect(f.sourcePath, `required field "${f.key}" has no source path`).toBeTruthy()
    }
  })
})
