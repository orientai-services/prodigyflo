'use client'

import { useEffect } from 'react'
import dynamic from 'next/dynamic'
import { Settings2 } from 'lucide-react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import type { TwilioStatusVM } from '@/lib/telephony/voice-contract'
import type { PhoneSetupVM } from '@/lib/telephony/ui/phone-setup-data'

// The four cards only draw inside the open sheet, so they load on their own (about 85 KB of client code that
// was on every Call Center first load for owners). They are fetched once the page is idle, so they are there
// by the time the sheet opens.
const loadStatus = () => import('./twilio-status-card')
const loadSync = () => import('./sync-numbers-dialog')
const loadRules = () => import('./calling-rules-card')
const loadDnc = () => import('./dnc-list-card')
const TwilioStatusCard = dynamic(() => loadStatus().then((m) => m.TwilioStatusCard))
const SyncNumbersDialog = dynamic(() => loadSync().then((m) => m.SyncNumbersDialog))
const CallingRulesCard = dynamic(() => loadRules().then((m) => m.CallingRulesCard))
const DncListCard = dynamic(() => loadDnc().then((m) => m.DncListCard))

function usePreloadCards(): void {
  useEffect(() => {
    const load = () => void Promise.all([loadStatus(), loadSync(), loadRules(), loadDnc()]).catch(() => {})
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(load, { timeout: 5000 })
      return () => window.cancelIdleCallback(id)
    }
    const timer = window.setTimeout(load, 2000)
    return () => window.clearTimeout(timer)
  }, [])
}

/**
 * The owner's phone tools inside Call Center. Settings → Phone numbers is
 * hidden while the final desk is on, so the same cards live here too.
 */
export function PhoneSetupSheet({
  setup,
  status,
  triggerClassName = 'btn secondary',
  open,
  onOpenChange,
}: {
  setup: PhoneSetupVM
  status: TwilioStatusVM | null
  triggerClassName?: string
  /** Controlled, so other buttons (the Call Center's phone pill and bottom bar) can open it too. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  usePreloadCards()
  return (
    <Sheet open={open} onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}>
      <SheetTrigger
        render={
          <button type="button" className={triggerClassName}>
            <Settings2 className="mr-1.5 inline size-3.5" aria-hidden />
            Phone setup
          </button>
        }
      />
      <SheetContent side="right" className="w-full overflow-y-auto max-sm:w-full! sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Phone setup</SheetTitle>
          <SheetDescription>The carrier account, calling rules and the do-not-call list.</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-6">
          <TwilioStatusCard initial={status} />
          {setup.showSync && (
            <div className="flex justify-end">
              <SyncNumbersDialog organizations={setup.organizations} />
            </div>
          )}
          <CallingRulesCard
            canManage={setup.canManage}
            consentForms={setup.consentForms}
            mediaAuthOff={status?.mediaAuth.state === 'off'}
          />
          <DncListCard canManage={setup.canManage} canAdd={setup.canAdd} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
