import type { Metadata } from 'next'
import { CallCenter } from '@/components/call-center/call-center'

export const metadata: Metadata = { title: 'Call Center' }

/** Staff preview for ad-form fills and ad-number calls. Dummy rows only. */
export default function CallCenterPage() {
  return <CallCenter />
}
