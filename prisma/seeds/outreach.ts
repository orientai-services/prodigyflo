import type { CommunicationChannel, PrismaClient } from '@prisma/client'

type Ctx = { organizationId: string; users: { id: string; email: string; role: string }[]; clientIds: string[] }

type T = {
  key: string
  name: string
  channel: CommunicationChannel
  locale: string
  subject: string | null
  body: string
  description: string
}

/**
 * Business-outreach templates: first contact, value pitch, partnership,
 * follow-ups, and re-engagement. Written to be sent as-is — specific, short,
 * no filler — with the sender's real identity via {{sender_name}} /
 * {{signature}} (the signature is placed explicitly so senders control where
 * it lands). Idempotent: upserts on (org, key, locale).
 */
const OUTREACH: T[] = [
  {
    key: 'outreach_intro_email',
    name: 'Outreach · First contact',
    channel: 'EMAIL',
    locale: 'en',
    subject: 'Quick question about {{company_name}} clients stuck in solar contracts',
    body: `Hi {{first_name}},

I'll keep this short. We help homeowners who regret their solar agreement — mis-sold terms, escalating payments, systems that never delivered — work toward a clean exit, handled start to finish.

If people ever land on your desk with that problem, I'd love to be the place you send them. No cost to you or them for the first review.

Worth a 10-minute call this week?

{{signature}}`,
    description: 'Cold introduction to a business that meets solar-troubled homeowners.',
  },
  {
    key: 'outreach_intro_email',
    name: 'Outreach · Primer contacto',
    channel: 'EMAIL',
    locale: 'es',
    subject: 'Una pregunta rápida sobre clientes atrapados en contratos solares',
    body: `Hola {{first_name}}:

Seré breve. Ayudamos a propietarios que se arrepienten de su contrato solar — términos engañosos, pagos que suben, sistemas que no cumplen — a buscar una salida limpia, de principio a fin.

Si alguna vez le llegan personas con ese problema, me encantaría ser a quien las envíe. La primera revisión no tiene costo para usted ni para ellos.

¿Le parece una llamada de 10 minutos esta semana?

{{signature}}`,
    description: 'Introducción en frío a un negocio que conoce propietarios con problemas solares.',
  },
  {
    key: 'outreach_referral_email',
    name: 'Outreach · Referral partnership',
    channel: 'EMAIL',
    locale: 'en',
    subject: 'A referral lane for your solar-complaint calls',
    body: `Hi {{first_name}},

Every roofer, realtor, and lender we work with gets the same call eventually: "my solar payment doubled and nobody answers the phone."

We built a lane for exactly that. You hand us the homeowner, we handle the review, the paperwork, and the updates — and you stay the hero who knew who to call.

I can walk you through how the handoff works in one short call. When suits you?

{{signature}}`,
    description: 'Propose a referral partnership to adjacent trades (roofing, realty, lending).',
  },
  {
    key: 'outreach_value_email',
    name: 'Outreach · Value follow-up',
    channel: 'EMAIL',
    locale: 'en',
    subject: 'The three things we check on any solar contract',
    body: `Hi {{first_name}},

Following up with something useful rather than a nudge. When a solar agreement crosses our desk, three checks decide most cases:

1. Was the escalator disclosed the way the law requires?
2. Does the signed contract match what the salesperson promised?
3. Was the homeowner's language the language of the paperwork?

If any of those fail, there's usually a path. Keep the list — or send us the contract and we'll run all three at no cost.

{{signature}}`,
    description: 'Second-touch email that leads with useful content instead of a nudge.',
  },
  {
    key: 'outreach_followup_email',
    name: 'Outreach · Gentle follow-up',
    channel: 'EMAIL',
    locale: 'en',
    subject: 'Re: {{company_name}} — still worth 10 minutes?',
    body: `Hi {{first_name}},

Circling back once — I know inboxes swallow things. If helping stuck solar customers isn't a fit for {{company_name}}, a one-line "not for us" closes the loop and I'll stop here.

If it might be, my calendar's open this week.

{{signature}}`,
    description: 'One polite follow-up with an explicit easy out.',
  },
  {
    key: 'outreach_reengage_email',
    name: 'Outreach · Re-engage a cold contact',
    channel: 'EMAIL',
    locale: 'en',
    subject: 'Since we last spoke — new options for stuck solar customers',
    body: `Hi {{first_name}},

We spoke a while back about homeowners trapped in solar agreements. Since then our process has gotten faster and the first review is still free — so the offer is easier to say yes to than it was.

If any of your customers are in that spot today, send one over and judge us by the result.

{{signature}}`,
    description: 'Warm-up for contacts who went quiet months ago.',
  },
  {
    key: 'outreach_intro_sms',
    name: 'Outreach · Intro (SMS)',
    channel: 'SMS',
    locale: 'en',
    subject: null,
    body: 'Hi {{first_name}}, this is {{sender_nickname}} with {{company_name}}. We help homeowners stuck in bad solar contracts — if that ever comes up with your customers, happy to be your referral. OK to send a one-pager?',
    description: 'Short first-touch SMS for business contacts who prefer text.',
  },
]

export async function seedOutreach(db: PrismaClient, ctx: Ctx): Promise<void> {
  const author = ctx.users.find((u) => u.role === 'ADMIN') ?? ctx.users[0]
  for (const t of OUTREACH) {
    await db.messageTemplate.upsert({
      where: { organizationId_key_locale: { organizationId: ctx.organizationId, key: t.key, locale: t.locale } },
      create: { organizationId: ctx.organizationId, createdById: author?.id ?? null, isActive: true, ...t },
      update: { name: t.name, subject: t.subject, body: t.body, description: t.description },
    })
  }
}
