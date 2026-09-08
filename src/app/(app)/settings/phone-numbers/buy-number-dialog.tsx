'use client'

import { useActionState, useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useFormStatus } from 'react-dom'
import { toast } from 'sonner'
import type { CallRouting, PhoneNumberKind } from '@prisma/client'
import {
  AlertCircle,
  CheckCircle2,
  CreditCard,
  KeyRound,
  Loader2,
  Phone,
  Search,
  ShieldCheck,
  Wallet,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { AvailableNumber } from '@/lib/telephony/provider'
import {
  buyNumberAction,
  confirmProvisioningPassphraseAction,
  searchNumbersAction,
  type PassphraseState,
} from './actions'
import type { ConsoleVM } from './types'

/**
 * Getting a number, in three plain steps: pick one, say what it is for and who
 * it rings, confirm the cost.
 *
 * The confirm step is where the two billing modes diverge, and it is the only
 * place a user has to know they differ:
 *
 *  - a client account sees the price and its balance, and the button is only
 *    live when the balance covers it;
 *  - an internal account sees "charged to the agency card" and one extra
 *    field — the agency provisioning passphrase — which unlocks purchases for
 *    ten minutes.
 */

type Step = 'search' | 'configure' | 'confirm'

export function BuyNumberDialog({ vm, trigger }: { vm: ConsoleVM; trigger?: React.ReactElement }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>('search')
  const [pending, startTransition] = useTransition()

  // search
  const [kind, setKind] = useState<PhoneNumberKind>('LOCAL')
  const [areaCode, setAreaCode] = useState('')
  const [results, setResults] = useState<AvailableNumber[] | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [picked, setPicked] = useState<AvailableNumber | null>(null)

  // configure
  const [friendlyName, setFriendlyName] = useState('')
  const [routing, setRouting] = useState<CallRouting>('VOICEMAIL_ONLY')
  const [forwardTo, setForwardTo] = useState('')

  // confirm
  const [buyError, setBuyError] = useState<string | null>(null)
  const [unlocked, setUnlocked] = useState(false)

  const onAgencyCard = vm.billingMode === 'AGENCY_CARD'
  const quote = vm.pricing[kind]
  const affordable = onAgencyCard || vm.balanceCents >= quote.dueTodayCents

  const reset = () => {
    setStep('search')
    setResults(null)
    setPicked(null)
    setSearchError(null)
    setBuyError(null)
    setFriendlyName('')
    setRouting('VOICEMAIL_ONLY')
    setForwardTo('')
    // `unlocked` deliberately survives a reset: the server grant lasts ten
    // minutes, so buying three numbers in a row should ask once. An expired
    // grant re-shows the field via the PASSPHRASE_REQUIRED branch in buy().
  }

  const search = () => {
    setSearchError(null)
    startTransition(async () => {
      const res = await searchNumbersAction({
        kind,
        areaCode: kind === 'LOCAL' ? areaCode : null,
        limit: 8,
      })
      if (!res.ok) {
        setResults([])
        setSearchError(res.error)
        return
      }
      setResults(res.numbers)
      if (res.numbers.length === 0) {
        setSearchError(
          kind === 'LOCAL'
            ? `No numbers are available in ${areaCode || 'that area code'} right now. Try a nearby one, or choose toll-free.`
            : 'No toll-free numbers are available right now. Try again in a moment.',
        )
      }
    })
  }

  const buy = () => {
    if (!picked) return
    setBuyError(null)
    startTransition(async () => {
      const res = await buyNumberAction({
        e164: picked.e164,
        kind,
        friendlyName: friendlyName.trim() || `${vm.organizationName} line`,
        routing,
        forwardTo: routing === 'FORWARD' ? forwardTo : null,
      })
      if (!res.ok) {
        // The ten-minute grant lapsed (or never existed): put the passphrase
        // field back rather than leaving a green panel above a refusal.
        if (res.code === 'PASSPHRASE_REQUIRED') setUnlocked(false)
        setBuyError(res.error)
        return
      }
      toast.success(`${picked.friendly} is live on this account.`)
      setOpen(false)
      reset()
      router.refresh()
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) reset()
      }}
    >
      <DialogTrigger
        render={
          trigger ?? (
            <Button size="sm" disabled={!vm.canManage}>
              <Phone className="size-3.5" />
              Get a number
            </Button>
          )
        }
      />
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {step === 'search' ? 'Get a phone number' : step === 'configure' ? 'Set the line up' : 'Confirm'}
          </DialogTitle>
          <DialogDescription>
            {step === 'search'
              ? `A new line for ${vm.organizationName}. Clients call and text it; every call lands on their timeline.`
              : step === 'configure'
                ? 'Name it so the team knows what it is, then choose what happens when it rings.'
                : onAgencyCard
                  ? 'This account bills to the agency card, so one more check stands between here and a charge.'
                  : 'Here is what this costs and what it leaves on the balance.'}
          </DialogDescription>
        </DialogHeader>

        {vm.mockCarrier && step === 'search' && (
          <p className="border-warning/40 bg-warning/10 text-warning flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" />
            <span>
              No carrier is connected yet, so these are practice numbers from the built-in test carrier. Everything
              works end to end — the numbers just are not dialable until Twilio credentials are in place.
            </span>
          </p>
        )}

        {/* ── 1. Pick a number ── */}
        {step === 'search' && (
          <div className="space-y-4">
            <div className="grid grid-cols-[1fr_auto] items-end gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="buy-kind" className="text-xs font-medium">
                  Number type
                </Label>
                <NativeSelect
                  id="buy-kind"
                  size="sm"
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value as PhoneNumberKind)
                    setResults(null)
                    setPicked(null)
                  }}
                >
                  <option value="LOCAL">Local — a number in your area</option>
                  <option value="TOLL_FREE">Toll-free — 800, 833, 844…</option>
                </NativeSelect>
              </div>
              <span className="text-muted-foreground pb-2 text-xs tabular-nums">
                {quote.monthlyLabel} / month
              </span>
            </div>

            {kind === 'LOCAL' && (
              <div className="space-y-1.5">
                <Label htmlFor="buy-area" className="text-xs font-medium">
                  Area code
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="buy-area"
                    inputMode="numeric"
                    maxLength={3}
                    placeholder="702"
                    value={areaCode}
                    onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, '').slice(0, 3))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') search()
                    }}
                    className="h-8 w-24 font-mono tabular-nums"
                  />
                  <Button size="sm" variant="outline" onClick={search} disabled={pending}>
                    {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
                    Find numbers
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                  A local number in the area you sell to gets answered more often than an out-of-state one.
                </p>
              </div>
            )}

            {kind === 'TOLL_FREE' && (
              <Button size="sm" variant="outline" onClick={search} disabled={pending}>
                {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
                Find toll-free numbers
              </Button>
            )}

            {searchError && (
              <p className="text-danger flex items-start gap-2 text-xs">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                {searchError}
              </p>
            )}

            {results && results.length > 0 && (
              <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-1">
                {results.map((n) => (
                  <button
                    key={n.e164}
                    type="button"
                    onClick={() => setPicked(n)}
                    className={cn(
                      'flex w-full items-center justify-between gap-3 rounded-sm px-2.5 py-2 text-left text-sm transition-colors',
                      picked?.e164 === n.e164 ? 'bg-brand-soft ring-ring ring-1' : 'hover:bg-muted',
                    )}
                  >
                    <span className="font-mono font-medium tabular-nums">{n.friendly}</span>
                    <span className="text-muted-foreground flex items-center gap-2 text-xs">
                      {[n.locality, n.region].filter(Boolean).join(', ') || 'Toll-free'}
                      {picked?.e164 === n.e164 && <CheckCircle2 className="text-success size-3.5" />}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── 2. Name it and route it ── */}
        {step === 'configure' && picked && (
          <div className="space-y-4">
            <div className="bg-muted/50 flex items-center justify-between rounded-md border px-3 py-2">
              <span className="font-mono text-sm font-medium tabular-nums">{picked.friendly}</span>
              <Badge variant="outline">{kind === 'TOLL_FREE' ? 'Toll-free' : 'Local'}</Badge>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="buy-label" className="text-xs font-medium">
                What is this line for?
              </Label>
              <Input
                id="buy-label"
                value={friendlyName}
                onChange={(e) => setFriendlyName(e.target.value)}
                placeholder={`${vm.organizationName} main line`}
                className="h-8"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="buy-routing" className="text-xs font-medium">
                When someone calls it
              </Label>
              <NativeSelect
                id="buy-routing"
                size="sm"
                value={routing}
                onChange={(e) => setRouting(e.target.value as CallRouting)}
              >
                <option value="FORWARD">Ring a phone I choose</option>
                <option value="VOICEMAIL_ONLY">Take a voicemail</option>
              </NativeSelect>
              <p className="text-muted-foreground text-xs">
                Either way the call is written to the client&apos;s timeline, and an unanswered call falls through to
                voicemail. You can switch this — and ring a whole team in turn — any time after buying.
              </p>
            </div>

            {routing === 'FORWARD' && (
              <div className="space-y-1.5">
                <Label htmlFor="buy-forward" className="text-xs font-medium">
                  Ring this number
                </Label>
                <Input
                  id="buy-forward"
                  value={forwardTo}
                  onChange={(e) => setForwardTo(e.target.value)}
                  placeholder="(702) 555-0199"
                  className="h-8 font-mono tabular-nums"
                />
              </div>
            )}
          </div>
        )}

        {/* ── 3. Money ── */}
        {step === 'confirm' && picked && (
          <div className="space-y-4">
            <div className="space-y-2 rounded-md border p-3 text-sm">
              <Row label="Number" value={picked.friendly} mono />
              <Row label="Label" value={friendlyName.trim() || `${vm.organizationName} line`} />
              <Row label="Monthly" value={quote.monthlyLabel} />
              <div className="border-t pt-2">
                <Row label="Due now" value={quote.dueTodayLabel} strong />
              </div>
            </div>

            {onAgencyCard ? (
              <AgencyCardGate
                configured={vm.passphraseConfigured}
                unlocked={unlocked}
                onUnlocked={() => {
                  setUnlocked(true)
                  // The refusal that sent them here is answered — leaving it on
                  // screen next to a green "unlocked" panel reads as a failure.
                  setBuyError(null)
                }}
              />
            ) : (
              <div
                className={cn(
                  'flex items-start gap-2 rounded-md border px-3 py-2 text-xs',
                  affordable
                    ? 'border-success/40 bg-success/10 text-success'
                    : 'border-warning/40 bg-warning/10 text-warning',
                )}
              >
                <Wallet className="mt-0.5 size-4 shrink-0" />
                <span>
                  {affordable
                    ? `Paid from this account's balance of ${vm.balanceLabel}.`
                    : `This account's balance is ${vm.balanceLabel} — not enough for this number. Add funds first.`}
                </span>
              </div>
            )}

            {buyError && (
              <p className="text-danger flex items-start gap-2 text-xs">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                {buyError}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {step !== 'search' && (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setStep(step === 'confirm' ? 'configure' : 'search')}
            >
              Back
            </Button>
          )}
          {step === 'search' && (
            <Button size="sm" disabled={!picked || pending} onClick={() => setStep('configure')}>
              Continue
            </Button>
          )}
          {step === 'configure' && (
            <Button
              size="sm"
              disabled={pending || (routing === 'FORWARD' && forwardTo.replace(/\D/g, '').length < 10)}
              onClick={() => setStep('confirm')}
            >
              Continue
            </Button>
          )}
          {step === 'confirm' && (
            <Button size="sm" disabled={pending || !affordable || (onAgencyCard && !unlocked)} onClick={buy}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Phone className="size-3.5" />}
              {onAgencyCard ? 'Charge the agency card' : `Pay ${quote.dueTodayLabel}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Row({ label, value, mono, strong }: { label: string; value: string; mono?: boolean; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span
        className={cn(
          'text-sm tabular-nums',
          mono && 'font-mono',
          strong ? 'font-semibold' : 'font-medium',
        )}
      >
        {value}
      </span>
    </div>
  )
}

function PassphraseSubmit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="sm" variant="outline" disabled={pending}>
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
      Unlock
    </Button>
  )
}

/**
 * The extra lock on internal accounts. The passphrase is checked by a server
 * action and converts into a ten-minute grant, so a run of several numbers only
 * asks once — and a stolen session with an admin login still cannot spend the
 * card without it.
 */
function AgencyCardGate({
  configured,
  unlocked,
  onUnlocked,
}: {
  configured: boolean
  unlocked: boolean
  onUnlocked: () => void
}) {
  const [state, action] = useActionState<PassphraseState, FormData>(confirmProvisioningPassphraseAction, {})

  useEffect(() => {
    if (state.granted) onUnlocked()
  }, [state.granted, onUnlocked])

  if (!configured) {
    return (
      <p className="border-warning/40 bg-warning/10 text-warning flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        <span>
          No provisioning passphrase is set on this server, so nothing can be charged to the agency card yet. An
          owner sets <code className="font-mono">TELEPHONY_AGENCY_PASSPHRASE_HASH</code> and restarts the app.
        </span>
      </p>
    )
  }

  if (unlocked || state.granted) {
    return (
      <p className="border-success/40 bg-success/10 text-success flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
        <span>Unlocked. Numbers can be charged to the agency card for the next ten minutes.</span>
      </p>
    )
  }

  return (
    <form action={action} className="space-y-2 rounded-md border p-3">
      <div className="flex items-start gap-2">
        <CreditCard className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <p className="text-muted-foreground text-xs">
          This is an internal account, so the number goes on the agency card rather than a prepaid balance. Enter the
          agency provisioning passphrase to authorise it.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Input
          name="passphrase"
          type="password"
          autoComplete="off"
          placeholder="Provisioning passphrase"
          className="h-8 flex-1"
        />
        <PassphraseSubmit />
      </div>
      {state.error && (
        <p className="text-danger flex items-start gap-2 text-xs">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          {state.error}
        </p>
      )}
    </form>
  )
}
