'use client'

import { Settings2 } from 'lucide-react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import type { TwilioStatusVM } from '@/lib/telephony/voice-contract'
import type { PhoneSetupVM } from '@/lib/telephony/ui/phone-setup-data'
import { CallingRulesCard } from './calling-rules-card'
import { DncListCard } from './dnc-list-card'
import { SyncNumbersDialog } from './sync-numbers-dialog'
import { TwilioStatusCard } from './twilio-status-card'

/**
 * The owner's phone tools inside Call Center. Settings → Phone numbers is
 * hidden while the final desk is on, so the same cards live here too.
 */
export function PhoneSetupSheet({
  setup,
  status,
  triggerClassName = 'btn secondary',
}: {
  setup: PhoneSetupVM
  status: TwilioStatusVM | null
  triggerClassName?: string
}) {
  return (
    <Sheet>
      <SheetTrigger
        render={
          <button type="button" className={triggerClassName}>
            <Settings2 className="mr-1.5 inline size-3.5" aria-hidden />
            Phone setup
          </button>
        }
      />
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
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
