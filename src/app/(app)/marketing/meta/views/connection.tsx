import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { dateTime, relativeTime } from '@/lib/format'
import type { ConnectionView } from '@/lib/meta/ads/read'
import { RecheckButton, RematchButton, TestLeadButton } from '../meta-islands'
import { CheckRow, type CheckState } from './parts'

function yesNo(v: boolean | null, good: boolean): CheckState {
  if (v === null) return 'unknown'
  return v === good ? 'ok' : 'bad'
}

function when(d: Date | null): string {
  return d ? `${relativeTime(d)} (${dateTime(d)})` : 'Not yet'
}

export function ConnectionViewSection({ data }: { data: ConnectionView }) {
  const t = data.token
  const now = new Date()
  const backingOff = data.backoffUntil !== null && data.backoffUntil > now
  const isSystemUser = t.type === null ? null : t.type === 'SYSTEM_USER'
  const usageHigh = data.usagePct !== null && data.usagePct >= 75
  // Sample mode runs only in development and preview, before anything is bound.
  const sample = data.mode === 'mock' && !data.boundHere

  return (
    <div className="space-y-4">
      <Card>
        <CardContent>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">Connection checklist</h2>
              <p className="text-muted-foreground mt-0.5 text-xs">
                Everything here should be green. A red line means something needs fixing in Meta or in ProdigyFlo.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <RecheckButton />
              <RematchButton />
            </div>
          </div>

          <ul className="mt-2 divide-y">
            <CheckRow
              state={data.mode === 'live' ? 'ok' : data.mode === 'mock' ? 'unknown' : 'bad'}
              label={
                data.mode === 'live'
                  ? 'Connected to Meta'
                  : data.mode === 'mock'
                    ? 'Showing sample data (this is not production)'
                    : "Not connected to Meta"
              }
              detail={data.mode === 'not_connected' ? 'Ads credentials are missing or incomplete. Check Connectors → Meta Ads.' : undefined}
            />
            <CheckRow
              state={data.boundHere ? 'ok' : sample ? 'unknown' : 'bad'}
              label={
                data.boundHere
                  ? 'Ads reporting is set up for this workspace'
                  : sample
                    ? 'No workspace is set up for ads reporting yet (sample data only)'
                    : 'Ads reporting is set up for a different workspace'
              }
            />
            <CheckRow
              state={data.allowlist.configured ? 'ok' : sample ? 'unknown' : 'bad'}
              label={
                data.allowlist.configured
                  ? 'Approved ad account list is set'
                  : sample
                    ? 'No approved ad account is set yet (sample data only)'
                    : 'No approved ad account is set'
              }
            >
              {data.allowlist.accounts.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {data.allowlist.accounts.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-mono">{a.id}</span>
                      {a.name && <span className="text-muted-foreground">{a.name}</span>}
                      {a.reachable === null ? (
                        <Badge variant="outline" className="text-muted-foreground">Not checked yet</Badge>
                      ) : a.reachable ? (
                        <Badge variant="outline" className="text-success border-success/40">Reachable</Badge>
                      ) : (
                        <Badge variant="destructive">Not reachable</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CheckRow>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="text-sm font-semibold">Ads token</h2>
          <ul className="mt-2 divide-y">
            <CheckRow
              state={yesNo(t.valid, true)}
              label={t.valid === null ? 'Token not checked yet' : t.valid ? 'Token is valid' : 'Token is not valid'}
              detail={
                t.valid === false
                  ? 'Generate a new System User token and save it in Connectors → Meta Ads.'
                  : t.expiresAt
                    ? `Expires ${dateTime(t.expiresAt)}`
                    : t.valid
                      ? 'Never expires'
                      : undefined
              }
            />
            <CheckRow
              state={yesNo(t.appMatches, true)}
              label={
                t.appMatches === false
                  ? "The token doesn't belong to ProdigyFlo's Meta app"
                  : "Token belongs to ProdigyFlo's Meta app"
              }
            />
            <CheckRow
              state={yesNo(isSystemUser, true)}
              label={isSystemUser === false ? `Token type is ${t.type}, not a system user` : 'Token is a system user token'}
            />
            <CheckRow
              state={yesNo(t.targetsOk, true)}
              label={
                t.targetsOk === false
                  ? 'Ads permissions are not limited to the approved ad account'
                  : 'Ads permissions are limited to the approved ad account'
              }
            >
              {t.scopes.length > 0 && (
                <span className="mt-1.5 flex flex-wrap gap-1">
                  {t.scopes.map((s) => (
                    <Badge key={s} variant="outline" className="font-mono">{s}</Badge>
                  ))}
                </span>
              )}
            </CheckRow>
            <CheckRow
              state={t.seesOthers ? 'bad' : t.valid === null ? 'unknown' : 'ok'}
              label={
                t.seesOthers
                  ? 'This token can also reach other ad accounts. Remove them from the ProdigyFlo system user in Meta Business Settings.'
                  : 'Token reaches only the approved ad account'
              }
            />
            <CheckRow
              state={yesNo(data.leadOrgMatches, true)}
              label={
                data.leadOrgMatches === false
                  ? 'Meta leads arrive in a different ProdigyFlo workspace'
                  : 'Meta leads arrive in this workspace'
              }
              detail={data.leadOrgMatches === false ? "The funnel can't match leads to ads until both are in the same workspace." : undefined}
            />
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="text-sm font-semibold">Syncing</h2>
          <ul className="mt-2 divide-y">
            <CheckRow state={data.lastFullSyncAt ? 'ok' : 'unknown'} label="Last full sync" detail={when(data.lastFullSyncAt)} />
            <CheckRow state={data.lastSnapshotAt ? 'ok' : 'unknown'} label="Last balance check" detail={when(data.lastSnapshotAt)} />
            <CheckRow
              state={data.usagePct === null ? 'unknown' : usageHigh ? 'bad' : 'ok'}
              label={data.usagePct === null ? 'Meta usage not reported yet' : `Meta usage at ${data.usagePct}% of the limit`}
              detail={backingOff ? `Paused to stay under Meta's limit until ${dateTime(data.backoffUntil)}.` : undefined}
            />
            <CheckRow
              state={data.truncated ? 'bad' : 'ok'}
              label={data.truncated ? "Some rows weren't loaded" : 'All rows loaded'}
              detail={data.truncated ? 'Meta returned more rows than one sync reads. Numbers may be missing some ads.' : undefined}
            />
            <CheckRow
              state={data.writesEnabled ? 'unknown' : 'ok'}
              label={data.writesEnabled ? 'Changes from ProdigyFlo are turned on' : 'Changes from ProdigyFlo are turned off'}
              detail={data.writesEnabled ? 'Pausing, resuming and budget changes can be made here.' : 'Changes are made in Meta Ads Manager.'}
            />
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="text-sm font-semibold">Recent problems</h2>
          {data.errors.length === 0 ? (
            <p className="text-muted-foreground mt-2 text-sm">None.</p>
          ) : (
            <ul className="mt-2 divide-y">
              {data.errors.slice(0, 5).map((e, i) => (
                <li key={i} className="py-2">
                  <p className="text-sm">{e.plain.replace('{time}', 'a short wait')}</p>
                  <p className="text-muted-foreground text-xs">{dateTime(e.at)}</p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-muted-foreground text-xs">
        Lead form intake (the webhook) is set up separately: its credentials are in{' '}
        <Link href="/settings/connectors" className="underline underline-offset-2">Connectors</Link>, and its callback
        URL and verify token are below.
      </p>
      {data.mode === 'mock' && (
        <div className="flex flex-wrap items-center gap-2">
          <TestLeadButton />
          <span className="text-muted-foreground text-xs">Sends a sample lead through intake, in sample mode only.</span>
        </div>
      )}
    </div>
  )
}
