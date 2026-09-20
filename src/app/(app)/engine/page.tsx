import { notFound } from 'next/navigation'
import { finalDeskEnabled } from '@/lib/final-desk/data'
import { FinalDeskPage } from '@/components/final-desk/page'
/** Lightweight suggestion view only; the retired Engine worker remains retired. */
export default async function EnginePage() {
  if (finalDeskEnabled()) return <FinalDeskPage view="engine" />
  notFound()
}
