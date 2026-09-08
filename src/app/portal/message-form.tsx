'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, SendHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { sendPortalMessage } from './actions'

/** The client's reply box — writes to the team, never sends anything outbound. */
export function MessageForm({
  placeholder,
  sendLabel,
  sendingLabel,
  sentMessage,
  emptyMessage,
}: {
  placeholder: string
  sendLabel: string
  sendingLabel: string
  sentMessage: string
  emptyMessage: string
}) {
  const router = useRouter()
  const [body, setBody] = useState('')
  const [pending, startTransition] = useTransition()

  const submit = () => {
    const trimmed = body.trim()
    if (!trimmed) {
      toast.error(emptyMessage)
      return
    }
    startTransition(async () => {
      const res = await sendPortalMessage({ body: trimmed })
      if (res.ok) {
        toast.success(sentMessage)
        setBody('')
        router.refresh()
      } else {
        toast.error(res.error)
      }
    })
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
        rows={3}
        maxLength={4000}
        disabled={pending}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            submit()
          }
        }}
      />
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={pending || body.trim().length === 0}>
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <SendHorizontal className="size-3.5" />}
          {pending ? sendingLabel : sendLabel}
        </Button>
      </div>
    </form>
  )
}
