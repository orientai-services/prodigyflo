'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

const ACCOUNTS = [
  { email: 'super@prodigyflo.ai', role: 'Super Admin', blurb: 'Everything, including roles and audit log' },
  { email: 'admin@prodigyflo.ai', role: 'Admin / Operations', blurb: 'All clients, configuration, submissions' },
  { email: 'rm.west@prodigyflo.ai', role: 'Regional Manager', blurb: 'West region, teams and closer comparison' },
  { email: 'sm.west1@prodigyflo.ai', role: 'Sales Manager', blurb: 'One team’s pipeline and performance' },
  { email: 'marisol.west00@prodigyflo.ai', role: 'Closer', blurb: 'Own assigned clients and daily work' },
  { email: 'collector1@prodigyflo.ai', role: 'Document Collector', blurb: 'Only assigned document requests' },
  { email: 'marketing@prodigyflo.ai', role: 'Marketing', blurb: 'Attribution, funnel, campaign performance' },
  { email: 'client@prodigyflo.ai', role: 'Client', blurb: 'The client-facing portal' },
]

export function DemoAccounts() {
  const [copied, setCopied] = useState<string | null>(null)

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value)
    setCopied(value)
    setTimeout(() => setCopied(null), 1400)
  }

  return (
    <div className="max-w-md">
      <h2 className="text-sm font-semibold">Demo accounts</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Synthetic data only. Staff password is not shown here — it lives in{' '}
        <code className="font-mono text-xs">DEMO_STAFF_PASSWORD</code>.
      </p>

      <ul className="mt-5 space-y-1">
        {ACCOUNTS.map((a) => (
          <li key={a.email}>
            <button
              onClick={() => copy(a.email)}
              className="hover:bg-accent group flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium">{a.role}</span>
                  <span className="text-muted-foreground truncate font-mono text-xs">{a.email}</span>
                </div>
                <p className="text-muted-foreground truncate text-xs">{a.blurb}</p>
              </div>
              {copied === a.email ? (
                <Check className="text-success size-4 shrink-0" />
              ) : (
                <Copy className="text-muted-foreground size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
