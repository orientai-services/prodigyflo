'use client'

import Link from 'next/link'
import { useMemo, useRef, useState, useTransition } from 'react'
import { CheckCircle2, FileUp, Loader2, RefreshCw, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import {
  CRM_FIELDS,
  MAX_IMPORT_ROWS,
  parseCsv,
  rowToRecord,
  suggestMapping,
  validateRecord,
  type ColumnMapping,
} from '@/lib/csv'
import {
  analyzeImportAction,
  commitImportAction,
  type CommitResult,
  type RowStatus,
} from './actions'

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-md border px-2 text-sm outline-none focus-visible:ring-3'

export function ImportWizard() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<string[][]>([])
  const [mapping, setMapping] = useState<ColumnMapping | null>(null)
  const [statuses, setStatuses] = useState<RowStatus[] | null>(null)
  const [result, setResult] = useState<CommitResult | null>(null)
  const [pending, startTransition] = useTransition()

  const records = useMemo(
    () => (mapping ? rows.map((r) => rowToRecord(r, mapping)) : []),
    [rows, mapping],
  )

  const onFile = (file: File | undefined) => {
    if (!file) return
    file.text().then((text) => {
      const parsed = parseCsv(text)
      if (parsed.headers.length === 0 || parsed.rows.length === 0) {
        toast.error('That file has no parsable rows.')
        return
      }
      if (parsed.rows.length > MAX_IMPORT_ROWS) {
        toast.error(`Imports are capped at ${MAX_IMPORT_ROWS} rows per file. Split the file and run again.`)
        return
      }
      setFileName(file.name)
      setHeaders(parsed.headers)
      setRows(parsed.rows)
      setMapping(suggestMapping(parsed.headers))
      setStatuses(null)
      setResult(null)
    })
  }

  const analyze = () => {
    if (!mapping) return
    startTransition(async () => {
      const res = await analyzeImportAction({ records, fileName })
      if (res.ok && res.statuses) {
        setStatuses(res.statuses)
      } else {
        toast.error(res.error ?? 'Could not analyze the file.')
      }
    })
  }

  const commit = () => {
    if (!mapping) return
    startTransition(async () => {
      const res = await commitImportAction({ records, fileName })
      if (res.ok) {
        setResult(res)
        setStatuses(null)
        toast.success(`Imported: ${res.created} new, ${res.updated} updated`)
      } else {
        toast.error(res.error ?? 'Import failed.')
      }
    })
  }

  // Local (pre-analysis) validity so mapping problems surface immediately.
  const localInvalid = useMemo(
    () => (mapping ? records.filter((r) => validateRecord(r).length > 0).length : 0),
    [records, mapping],
  )

  if (result) {
    return (
      <div className="max-w-xl px-4 py-6 sm:px-6">
        <div className="bg-card rounded-lg border p-5">
          <p className="flex items-center gap-2 text-sm font-medium">
            <CheckCircle2 className="text-success size-4" />
            Import finished
          </p>
          <ul className="text-muted-foreground mt-2 space-y-1 text-sm">
            <li>{result.created} new client{result.created === 1 ? '' : 's'} created</li>
            <li>{result.updated} existing client{result.updated === 1 ? '' : 's'} updated</li>
            <li>{result.unchanged} row{result.unchanged === 1 ? '' : 's'} already up to date</li>
            <li>{result.skipped} row{result.skipped === 1 ? '' : 's'} skipped</li>
          </ul>
          <p className="text-muted-foreground mt-3 text-xs">
            Re-importing the same file is safe: matching rows update instead of duplicating.
          </p>
          <div className="mt-4 flex gap-2">
            <Button size="sm" render={<Link href="/clients" />}>
              View clients
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setResult(null)
                setHeaders([])
                setRows([])
                setMapping(null)
                setFileName('')
                if (fileRef.current) fileRef.current.value = ''
              }}
            >
              <RefreshCw className="size-3.5" />
              Import another file
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5 px-4 py-5 sm:px-6">
      <div className="bg-card max-w-xl rounded-lg border p-4">
        <Label htmlFor="import-file" className="text-sm font-medium">
          CSV file
        </Label>
        <p className="text-muted-foreground mt-0.5 text-xs">
          First row must be column headers. Up to {MAX_IMPORT_ROWS} data rows per file.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <input
            ref={fileRef}
            id="import-file"
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => onFile(e.target.files?.[0])}
            className="text-sm file:mr-3 file:rounded-md file:border file:bg-transparent file:px-2.5 file:py-1 file:text-xs file:font-medium"
          />
          {fileName && (
            <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
              <FileUp className="size-3.5" />
              {rows.length} row{rows.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>

      {mapping && (
        <>
          <div className="bg-card rounded-lg border p-4">
            <p className="text-sm font-medium">Map columns to CRM fields</p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              Suggested from the header names — adjust anything that landed wrong.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {CRM_FIELDS.map((field) => (
                <div key={field.key} className="grid gap-1">
                  <Label htmlFor={`map-${field.key}`} className="text-xs">
                    {field.label}
                    {'required' in field && field.required ? ' *' : ''}
                  </Label>
                  <NativeSelect
                    id={`map-${field.key}`}
                    value={mapping[field.key]}
                    onChange={(e) => {
                      setMapping({ ...mapping, [field.key]: Number(e.target.value) } as ColumnMapping)
                      setStatuses(null)
                    }}
                    className={selectClass}
                  >
                    <option value={-1}>— not mapped —</option>
                    {headers.map((h, i) => (
                      <option key={`${h}-${i}`} value={i}>
                        {h || `Column ${i + 1}`}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              ))}
            </div>
            <div className="mt-4 flex items-center gap-3">
              <Button size="sm" onClick={analyze} disabled={pending}>
                {pending && <Loader2 className="size-3.5 animate-spin" />}
                Preview import
              </Button>
              {localInvalid > 0 && (
                <span className="text-warning text-xs">
                  {localInvalid} row{localInvalid === 1 ? '' : 's'} will be skipped with this mapping
                </span>
              )}
            </div>
          </div>

          {statuses && (
            <div className="bg-card rounded-lg border">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
                <p className="text-sm">
                  <span className="font-medium">{statuses.filter((s) => s.kind === 'new').length} new</span>
                  {' · '}
                  <span className="font-medium">{statuses.filter((s) => s.kind === 'update').length} duplicates to update</span>
                  {' · '}
                  <span className="font-medium">{statuses.filter((s) => s.kind === 'invalid').length} invalid</span>
                </p>
                <Button size="sm" onClick={commit} disabled={pending || statuses.every((s) => s.kind === 'invalid')}>
                  {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                  Import {statuses.filter((s) => s.kind !== 'invalid').length} rows
                </Button>
              </div>
              <div className="scroll-x max-h-96 overflow-y-auto">
                <table className="w-full min-w-[40rem] text-sm tabular-nums">
                  <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                    <tr className="border-b">
                      <th className="px-4 py-2 text-left">#</th>
                      <th className="px-4 py-2 text-left">Name</th>
                      <th className="px-4 py-2 text-left">Email / phone</th>
                      <th className="px-4 py-2 text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((r, i) => {
                      const status = statuses[i]
                      return (
                        <tr key={i} className="border-b">
                          <td className="text-muted-foreground px-4 py-1.5 text-xs tabular-nums">{i + 1}</td>
                          <td className="px-4 py-1.5">
                            {[r.firstName, r.lastName].filter(Boolean).join(' ') || (
                              <span className="text-muted-foreground italic">missing</span>
                            )}
                          </td>
                          <td className="text-muted-foreground px-4 py-1.5 text-xs">
                            {[r.email, r.phone].filter(Boolean).join(' · ') || '—'}
                          </td>
                          <td className="px-4 py-1.5">
                            {status.kind === 'new' && <Badge variant="secondary">New</Badge>}
                            {status.kind === 'update' && (
                              <span className="inline-flex items-center gap-1.5">
                                <Badge variant="outline">Update</Badge>
                                <span className="text-muted-foreground text-xs">
                                  {status.matchName} ({status.matchedOn})
                                </span>
                              </span>
                            )}
                            {status.kind === 'invalid' && (
                              <span className="inline-flex items-center gap-1.5">
                                <Badge variant="destructive">Skip</Badge>
                                <span className="text-muted-foreground text-xs">{status.errors.join('; ')}</span>
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
