import { redirect } from 'next/navigation'

// Lead-source performance moved into the Marketing perspective.
export default function LegacySourcesRedirect() {
  redirect('/marketing/sources')
}
