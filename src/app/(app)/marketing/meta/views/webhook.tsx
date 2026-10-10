import 'server-only'
import { Card, CardContent } from '@/components/ui/card'
import { metaVerifyToken } from '@/lib/meta'

/**
 * Callback URL and Verify token for the Lead Ads (and Instagram) webhooks.
 * Lead intake is separate from ads reporting, so this shows for admins
 * (connectors:manage) whatever the ads binding is. The caller checks the
 * permission.
 */
export function LeadWebhookCard() {
  const base = (process.env.APP_URL || 'http://localhost:3300').replace(/\/+$/, '')
  return (
    <Card>
      <CardContent className="space-y-3">
        <h2 className="text-sm font-semibold">Lead form webhook</h2>
        <dl className="space-y-2 text-sm">
          <div>
            <dt className="text-muted-foreground text-xs uppercase tracking-wide">Callback URL</dt>
            <dd className="font-mono text-xs break-all">{base}/api/meta/leads</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs uppercase tracking-wide">Instagram callback URL</dt>
            <dd className="font-mono text-xs break-all">{base}/api/meta/instagram</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs uppercase tracking-wide">Verify token</dt>
            <dd className="font-mono text-xs break-all">{metaVerifyToken()}</dd>
          </div>
        </dl>
        <p className="text-muted-foreground text-xs">
          Paste the callback URL and verify token into Meta → App Dashboard → Webhooks → Page → <code>leadgen</code>{' '}
          (and Instagram → messages, comments). Delivered leads go through the normal intake: checked, de-duplicated and
          logged.
        </p>
      </CardContent>
    </Card>
  )
}
