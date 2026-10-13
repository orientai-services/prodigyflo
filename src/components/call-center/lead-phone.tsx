'use client'

import { useEffect, useRef, useState } from 'react'
import { NUMBER_UNAVAILABLE, maskedLast4, type LeadPhoneView } from '@/lib/call-center/phone-display'
import './lead-phone.css'

/**
 * A lead's number as the viewer may see it (docs/DIALER_APP.md §Phone numbers):
 * the full number when the server sent one, "Number unavailable" when it can't
 * be read, else the last four. `copyable` turns the full number into a
 * tap-to-copy button. Never a tel: link: every dial goes through Call, where
 * the calling-rules check runs. Inside another button or link pass
 * `copyable={false}` (no nested controls).
 */
export function LeadPhone({
  phone,
  last4,
  copyable = true,
  className,
}: {
  phone?: LeadPhoneView | null
  last4: string | null | undefined
  copyable?: boolean
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const cls = ['lead-phone', className].filter(Boolean).join(' ')
  if (phone?.state === 'unavailable') return <span className={`${cls} unavailable`}>{NUMBER_UNAVAILABLE}</span>
  if (phone?.state !== 'shown') return <span className={`${cls} masked`}>{maskedLast4(last4)}</span>
  if (!copyable) return <span className={`${cls} full`}>{phone.display}</span>

  const copy = phone.copy
  return (
    <button
      type="button"
      className={`${cls} full copy`}
      title="Copy number"
      aria-label={copied ? `${phone.display}, copied` : `Copy ${phone.display}`}
      onClick={(event) => {
        event.stopPropagation()
        void navigator.clipboard?.writeText(copy).then(() => {
          setCopied(true)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 1500)
        }, () => undefined)
      }}
    >
      {phone.display}
      <span className="lead-phone-note" aria-hidden="true">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  )
}
