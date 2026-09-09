'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'

export function PacketCopy({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        await navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  )
}
