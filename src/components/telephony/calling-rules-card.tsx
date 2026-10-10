'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  addTeamNumber,
  getCallingRules,
  listTeamNumbers,
  removeTeamNumber,
  saveCallingRules,
  setConsentForms,
} from '@/lib/telephony/actions'
import type { CallingRulesVM } from '@/lib/telephony/voice-contract'
import { actionFailure, thrownMessage } from '@/lib/telephony/ui/result'

/**
 * The account's calling rules (plan §2.7): outbound recording, the calling
 * window, which Facebook forms carry consent language, and the team's own
 * numbers that may always be called.
 *
 * Strict do-not-call is the only mode, so there is no switch for it. The
 * window can only be narrowed inside 8:00–21:00; the server enforces the
 * same bounds and the federal ceiling whatever this form sends.
 */

export type ConsentFormVM = { formId: string; textVersion: string }
type TeamNumberVM = { hash: string; last4: string; label: string }

const HOURS = Array.from({ length: 14 }, (_, i) => i + 8) // 8 … 21

function hourLabel(h: number): string {
  if (h === 12) return '12:00 pm'
  return h < 12 ? `${h}:00 am` : `${h - 12}:00 pm`
}

export function CallingRulesCard({
  canManage,
  consentForms = [],
  mediaAuthOff = false,
}: {
  canManage: boolean
  consentForms?: ConsentFormVM[]
  /** Twilio media auth is known to be off; outbound recording can't be turned on. */
  mediaAuthOff?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [rules, setRules] = useState<CallingRulesVM | null>(null)
  const [team, setTeam] = useState<TeamNumberVM[]>([])
  const [forms, setForms] = useState<ConsentFormVM[]>(consentForms)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [teamPhone, setTeamPhone] = useState('')
  const [teamLabel, setTeamLabel] = useState('')
  const [formId, setFormId] = useState('')
  const [formVersion, setFormVersion] = useState('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await getCallingRules()
        const failure = actionFailure(res)
        if (cancelled) return
        if (failure) setError(failure.error)
        else setRules(res as CallingRulesVM)
        if (canManage) {
          const list = await listTeamNumbers()
          if (!cancelled && Array.isArray(list)) setTeam(list as TeamNumberVM[])
        }
      } catch (err) {
        if (!cancelled) setError(thrownMessage(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [canManage])

  const act = (run: () => Promise<unknown>, after?: () => void | Promise<void>) => {
    setError(null)
    setSaved(false)
    startTransition(async () => {
      try {
        const failure = actionFailure(await run())
        if (failure) {
          setError(failure.error)
          return
        }
        await after?.()
      } catch (err) {
        setError(thrownMessage(err))
      }
    })
  }

  const reloadTeam = async () => {
    const list = await listTeamNumbers()
    if (Array.isArray(list)) setTeam(list as TeamNumberVM[])
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Calling rules</CardTitle>
        <CardDescription>Calls and texts need consent on file. Marketing calls skip Sundays and federal holidays.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}

        {!rules ? (
          <p className="text-muted-foreground text-sm">{error ? '' : 'Loading…'}</p>
        ) : (
          <section className="space-y-3">
            <label className="flex items-start justify-between gap-4">
              <span>
                <span className="block text-sm font-medium">Record outbound calls</span>
                <span className="text-muted-foreground block text-xs">
                  {mediaAuthOff
                    ? 'Turn on HTTP auth for media in Twilio first. Recordings are public at Twilio until then.'
                    : "Callers hear 'This call may be recorded' when they answer."}
                </span>
              </span>
              <Switch
                checked={rules.recordOutbound}
                disabled={!canManage || pending || (mediaAuthOff && !rules.recordOutbound)}
                onCheckedChange={(checked) => setRules({ ...rules, recordOutbound: checked })}
                aria-label="Record outbound calls"
              />
            </label>

            <label className="flex items-start justify-between gap-4">
              <span>
                <span className="block text-sm font-medium">Transcribe voicemails</span>
                <span className="text-muted-foreground block text-xs">
                  Twilio writes out each voicemail (English, up to two minutes). The text shows under the voicemail.
                </span>
              </span>
              <Switch
                checked={rules.transcribeVoicemail !== false}
                disabled={!canManage || pending}
                onCheckedChange={(checked) => setRules({ ...rules, transcribeVoicemail: checked })}
                aria-label="Transcribe voicemails"
              />
            </label>

            <div className="flex flex-wrap items-end gap-3">
              <label className="grid gap-1 text-sm">
                <span className="text-muted-foreground text-xs">Calls start</span>
                <select
                  className="border-input bg-background h-8 rounded-md border px-2 text-sm"
                  value={rules.windowStart}
                  disabled={!canManage || pending}
                  onChange={(e) => setRules({ ...rules, windowStart: Number(e.target.value) })}
                  aria-label="Calls start"
                >
                  {HOURS.filter((h) => h < rules.windowEnd).map((h) => (
                    <option key={h} value={h}>
                      {hourLabel(h)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-muted-foreground text-xs">Calls end</span>
                <select
                  className="border-input bg-background h-8 rounded-md border px-2 text-sm"
                  value={rules.windowEnd}
                  disabled={!canManage || pending}
                  onChange={(e) => setRules({ ...rules, windowEnd: Number(e.target.value) })}
                  aria-label="Calls end"
                >
                  {HOURS.filter((h) => h > rules.windowStart).map((h) => (
                    <option key={h} value={h}>
                      {hourLabel(h)}
                    </option>
                  ))}
                </select>
              </label>
              <span className="text-muted-foreground pb-1.5 text-xs">Their local time.</span>
              {canManage && (
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => act(() => saveCallingRules(rules), () => setSaved(true))}
                >
                  {pending && <Loader2 className="size-3.5 animate-spin" />}
                  Save
                </Button>
              )}
              {saved && <span className="text-muted-foreground pb-1.5 text-xs">Saved.</span>}
            </div>
          </section>
        )}

        <section className="space-y-2">
          <h4 className="text-sm font-medium">Facebook forms with consent</h4>
          <p className="text-muted-foreground text-xs">
            Leads from these forms arrive with consent. Only add a form whose text carries the consent language. Leads
            already in don&rsquo;t change.
          </p>
          {forms.length === 0 ? (
            <p className="text-muted-foreground text-xs">No forms yet. Facebook leads need consent recorded another way.</p>
          ) : (
            <ul className="divide-y rounded-md border text-sm">
              {forms.map((f) => (
                <li key={f.formId} className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <span className="min-w-0 truncate">
                    Form <span className="font-mono text-xs">{f.formId}</span> · text {f.textVersion}
                  </span>
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove form ${f.formId}`}
                      disabled={pending}
                      onClick={() =>
                        act(
                          () => setConsentForms({ formId: f.formId, textVersion: null }),
                          () => {
                            setForms((list) => list.filter((x) => x.formId !== f.formId))
                            router.refresh()
                          },
                        )
                      }
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="h-8 w-40"
                placeholder="Form id"
                value={formId}
                onChange={(e) => setFormId(e.target.value.replace(/\D/g, ''))}
                aria-label="Facebook form id"
              />
              <Input
                className="h-8 w-40"
                placeholder="Consent text version"
                value={formVersion}
                maxLength={40}
                onChange={(e) => setFormVersion(e.target.value)}
                aria-label="Consent text version"
              />
              <Button
                variant="outline"
                size="sm"
                disabled={pending || !formId || !formVersion.trim()}
                onClick={() => {
                  const entry = { formId, textVersion: formVersion.trim() }
                  act(
                    () => setConsentForms(entry),
                    () => {
                      setForms((list) => [...list.filter((x) => x.formId !== entry.formId), entry])
                      setFormId('')
                      setFormVersion('')
                      router.refresh()
                    },
                  )
                }}
              >
                <Plus className="size-3.5" />
                Add form
              </Button>
            </div>
          )}
        </section>

        {canManage && (
          <section className="space-y-2">
            <h4 className="text-sm font-medium">Team numbers</h4>
            <p className="text-muted-foreground text-xs">
              Your own people&rsquo;s phones. They can always be called, without consent.
            </p>
            {team.length === 0 ? (
              <p className="text-muted-foreground text-xs">None yet.</p>
            ) : (
              <ul className="divide-y rounded-md border text-sm">
                {team.map((t) => (
                  <li key={t.hash} className="flex items-center justify-between gap-2 px-3 py-1.5">
                    <span>
                      <span className="font-mono tabular-nums">•••-•••-{t.last4}</span> · {t.label}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${t.label}`}
                      disabled={pending}
                      onClick={() => act(() => removeTeamNumber(t.hash), reloadTeam)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="h-8 w-40"
                type="tel"
                placeholder="Phone"
                value={teamPhone}
                onChange={(e) => setTeamPhone(e.target.value)}
                aria-label="Team phone number"
              />
              <Input
                className="h-8 w-40"
                placeholder="Whose phone"
                value={teamLabel}
                maxLength={60}
                onChange={(e) => setTeamLabel(e.target.value)}
                aria-label="Whose phone"
              />
              <Button
                variant="outline"
                size="sm"
                disabled={pending || !teamPhone.trim() || !teamLabel.trim()}
                onClick={() =>
                  act(
                    () => addTeamNumber({ phone: teamPhone.trim(), label: teamLabel.trim() }),
                    async () => {
                      setTeamPhone('')
                      setTeamLabel('')
                      await reloadTeam()
                    },
                  )
                }
              >
                <Plus className="size-3.5" />
                Add
              </Button>
            </div>
          </section>
        )}
      </CardContent>
    </Card>
  )
}
