'use client'

import { useActionState } from 'react'
import { CLOSER_EDITABLE_PERMISSIONS, PERMISSIONS } from '@/lib/permissions'
import { Button } from '@/components/ui/button'
import { updateCloserPermissionsAction, type CloserPermissionState } from './actions'

export function CloserPermissions({ selected }: { selected: string[] }) {
  const [state, action, pending] = useActionState<CloserPermissionState, FormData>(updateCloserPermissionsAction, {})
  return (
    <section className="rounded-lg border p-4">
      <h2 className="font-semibold">Closer permissions</h2>
      <p className="text-muted-foreground mb-4 text-sm">These actions apply to every Closer. Access always stays limited to assigned clients.</p>
      <form action={action}>
        <div className="grid gap-3 sm:grid-cols-2">
          {CLOSER_EDITABLE_PERMISSIONS.map((key) => (
            <label key={key} className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="permission" value={key} defaultChecked={selected.includes(key)} />
              {PERMISSIONS[key].description}
            </label>
          ))}
        </div>
        {state.error && <p role="alert" className="mt-3 text-sm text-destructive">{state.error}</p>}
        {state.saved && <p role="status" className="mt-3 text-sm">Saved. Changes apply on the next request.</p>}
        <Button type="submit" disabled={pending} className="mt-4">{pending ? 'Saving…' : 'Save Closer permissions'}</Button>
      </form>
    </section>
  )
}
