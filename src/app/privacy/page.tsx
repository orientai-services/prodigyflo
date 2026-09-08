import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'How Solar Contract Services collects, uses, and protects lead information.',
}

const UPDATED = 'August 29, 2026'
const CONTACT = 'privacy@prodigyflo.ai'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-foreground text-lg font-semibold">{title}</h2>
      <div className="text-muted-foreground mt-2 space-y-3 text-sm leading-relaxed">{children}</div>
    </section>
  )
}

export default function PrivacyPolicyPage() {
  return (
    <main className="bg-background text-foreground mx-auto min-h-full max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Privacy Policy</h1>
      <p className="text-muted-foreground mt-2 text-sm">Last updated: {UPDATED}</p>

      <p className="text-muted-foreground mt-6 text-sm leading-relaxed">
        This Privacy Policy explains how Solar Contract Services (&ldquo;we&rdquo;, &ldquo;us&rdquo;), a Nevada company,
        collects, uses, and protects information from people who contact us or submit an inquiry — including through
        lead forms on Facebook and Instagram. We are the data controller for the information described below.
      </p>

      <Section title="Information we collect">
        <p>
          When you submit a Facebook or Instagram Lead Ads form, or otherwise contact us, we receive the information you
          provide on that form, which typically includes:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Your name</li>
          <li>Your email address</li>
          <li>Your phone number</li>
          <li>Your answers to the questions on the specific form (e.g. your interest in solar services)</li>
        </ul>
        <p>
          We receive this information from Meta Platforms, Inc. only after you choose to submit a lead form, and only for
          the form fields you completed. We do not collect this information without your action.
        </p>
      </Section>

      <Section title="How we use your information">
        <p>We use the information you provide to:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Contact you about the solar products, services, or request you inquired about</li>
          <li>Respond to your questions and follow up on your inquiry</li>
          <li>Maintain a record of our communications with you</li>
          <li>Comply with legal obligations</li>
        </ul>
        <p>We do not use your information for automated decision-making that produces legal effects about you.</p>
      </Section>

      <Section title="How we share your information">
        <p>
          We do not sell your personal information. We share it only with service providers that help us operate our
          business — such as our customer-relationship-management (CRM) software, communication providers, and hosting
          providers — who are permitted to use it only to provide services to us, and with Meta as the source of the lead.
          We may also disclose information where required by law.
        </p>
      </Section>

      <Section title="How we store and protect your information">
        <p>
          Your information is stored in our CRM system with access controls, and sensitive credentials and secrets are
          held encrypted. We restrict access to your information to people who need it to serve you. No method of
          transmission or storage is perfectly secure, but we take reasonable measures to protect your information.
        </p>
      </Section>

      <Section title="How long we keep your information">
        <p>
          We keep your information for as long as needed to respond to your inquiry and for our legitimate business and
          legal purposes. When it is no longer needed, we delete or anonymize it.
        </p>
      </Section>

      <Section title="Your rights and choices">
        <p>
          You may request to access, correct, or delete the personal information we hold about you, and you may opt out
          of further contact at any time. To make a request — including a request to delete your data — email us at{' '}
          <a className="text-foreground underline" href={`mailto:${CONTACT}`}>
            {CONTACT}
          </a>{' '}
          and we will respond within a reasonable time. If you submitted a lead through Facebook or Instagram, you can
          also manage your activity through your Meta account settings.
        </p>
      </Section>

      <Section title="Data deletion requests">
        <p>
          To request deletion of the information we received about you, email{' '}
          <a className="text-foreground underline" href={`mailto:${CONTACT}`}>
            {CONTACT}
          </a>{' '}
          with the subject line &ldquo;Data Deletion Request&rdquo; and the email or phone number you submitted. We will
          delete your information from our systems and confirm once complete.
        </p>
      </Section>

      <Section title="Changes to this policy">
        <p>
          We may update this Privacy Policy from time to time. When we do, we will revise the &ldquo;Last updated&rdquo;
          date above.
        </p>
      </Section>

      <Section title="Contact us">
        <p>
          Questions about this policy or your information? Email{' '}
          <a className="text-foreground underline" href={`mailto:${CONTACT}`}>
            {CONTACT}
          </a>
          .
        </p>
      </Section>
    </main>
  )
}
