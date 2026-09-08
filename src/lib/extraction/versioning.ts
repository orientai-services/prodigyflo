/**
 * Version-chain planning for uploads. Pure so the invariants are testable:
 * a re-upload never overwrites — it becomes version N+1 superseding the
 * previous version. The only in-place fill is the very first upload landing
 * on a REQUESTED placeholder that has no file yet.
 */

export type ExistingDoc = {
  id: string
  version: number
  status: string
  storageKey: string | null
}

export type UploadPlan =
  | { mode: 'fill'; documentId: string; version: number }
  | { mode: 'new'; version: number; supersedesId: string | null }

export function planUpload(existing: ExistingDoc[]): UploadPlan {
  if (existing.length === 0) return { mode: 'new', version: 1, supersedesId: null }

  const withFile = existing.filter((d) => d.storageKey)
  const placeholder = existing.find((d) => !d.storageKey && d.status === 'REQUESTED')

  if (withFile.length === 0 && placeholder) {
    return { mode: 'fill', documentId: placeholder.id, version: placeholder.version }
  }

  const maxVersion = Math.max(...existing.map((d) => d.version))
  const latestWithFile = withFile.sort((a, b) => b.version - a.version)[0] ?? null

  // A re-upload requested via a newer REQUESTED placeholder fills that placeholder.
  const newerPlaceholder = existing.find(
    (d) => !d.storageKey && d.status === 'REQUESTED' && d.version > (latestWithFile?.version ?? 0),
  )
  if (newerPlaceholder) return { mode: 'fill', documentId: newerPlaceholder.id, version: newerPlaceholder.version }

  return { mode: 'new', version: maxVersion + 1, supersedesId: latestWithFile?.id ?? null }
}
