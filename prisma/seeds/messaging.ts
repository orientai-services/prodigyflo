import type { CommunicationChannel, PrismaClient } from '@prisma/client'

type SeedCtx = {
  organizationId: string
  users: { id: string; email: string; role: string }[]
  clientIds: string[]
}

type TemplateSeed = {
  key: string
  name: string
  channel: CommunicationChannel
  locale: string
  subject: string | null
  body: string
  description: string
}

// Deterministic starter templates: document request, follow-up, appointment
// reminder, and missing info — each as email + SMS, in English and Spanish.
const TEMPLATES: TemplateSeed[] = [
  // Document request
  {
    key: 'document_request_email',
    name: 'Document request',
    channel: 'EMAIL',
    locale: 'en',
    subject: 'Documents needed for your file, {{first_name}}',
    body: 'Hi {{first_name}},\n\nTo keep your file moving we still need your {{document_name}}. You can reply to this email with a photo or scan, or upload it through your portal.\n\nThank you,\n{{owner_name}}\n{{company_name}}',
    description: 'Ask the client to send an outstanding requested document.',
  },
  {
    key: 'document_request_email',
    name: 'Document request',
    channel: 'EMAIL',
    locale: 'es',
    subject: 'Documentos pendientes para su expediente, {{first_name}}',
    body: 'Hola {{first_name}}:\n\nPara avanzar con su expediente todavía necesitamos su {{document_name}}. Puede responder a este correo con una foto o un escaneo, o subirlo a través de su portal.\n\nGracias,\n{{owner_name}}\n{{company_name}}',
    description: 'Solicitud de documento pendiente (español).',
  },
  {
    key: 'document_request_sms',
    name: 'Document request (SMS)',
    channel: 'SMS',
    locale: 'en',
    subject: null,
    body: 'Hi {{first_name}}, this is {{owner_name}} with {{company_name}}. We still need your {{document_name}} to keep your file moving — a photo works. Reply STOP to opt out.',
    description: 'Short SMS nudge for an outstanding requested document.',
  },
  {
    key: 'document_request_sms',
    name: 'Document request (SMS)',
    channel: 'SMS',
    locale: 'es',
    subject: null,
    body: 'Hola {{first_name}}, le escribe {{owner_name}} de {{company_name}}. Aún necesitamos su {{document_name}} para avanzar con su expediente; una foto es suficiente. Responda STOP para no recibir más mensajes.',
    description: 'Recordatorio corto por SMS de documento pendiente (español).',
  },

  // Follow-up
  {
    key: 'follow_up_email',
    name: 'Follow-up',
    channel: 'EMAIL',
    locale: 'en',
    subject: 'Following up on your file, {{first_name}}',
    body: 'Hi {{first_name}},\n\nJust checking in on where things stand with your file. If you have any questions, reply to this email or give me a call and I will walk you through the next steps.\n\nBest,\n{{owner_name}}\n{{company_name}}',
    description: 'General check-in after a conversation or presentation.',
  },
  {
    key: 'follow_up_email',
    name: 'Follow-up',
    channel: 'EMAIL',
    locale: 'es',
    subject: 'Seguimiento de su expediente, {{first_name}}',
    body: 'Hola {{first_name}}:\n\nLe escribo para dar seguimiento a su expediente. Si tiene alguna pregunta, responda a este correo o llámeme y con gusto le explico los siguientes pasos.\n\nSaludos,\n{{owner_name}}\n{{company_name}}',
    description: 'Seguimiento general (español).',
  },
  {
    key: 'follow_up_sms',
    name: 'Follow-up (SMS)',
    channel: 'SMS',
    locale: 'en',
    subject: null,
    body: 'Hi {{first_name}}, {{owner_name}} with {{company_name}} here — just following up on your file. Any questions, just text back. Reply STOP to opt out.',
    description: 'Short SMS check-in.',
  },
  {
    key: 'follow_up_sms',
    name: 'Follow-up (SMS)',
    channel: 'SMS',
    locale: 'es',
    subject: null,
    body: 'Hola {{first_name}}, le escribe {{owner_name}} de {{company_name}} para dar seguimiento a su expediente. Si tiene preguntas, responda a este mensaje. Responda STOP para no recibir más mensajes.',
    description: 'Seguimiento corto por SMS (español).',
  },

  // Appointment reminder
  {
    key: 'appointment_reminder_email',
    name: 'Appointment reminder',
    channel: 'EMAIL',
    locale: 'en',
    subject: 'Reminder: your {{appointment_type}} appointment on {{appointment_date}}',
    body: 'Hi {{first_name}},\n\nThis is a reminder of your upcoming {{appointment_type}} appointment on {{appointment_date}}. If you need to reschedule, reply to this email and we will find a better time.\n\nSee you soon,\n{{owner_name}}\n{{company_name}}',
    description: 'Reminder for an upcoming appointment — requires an appointment context.',
  },
  {
    key: 'appointment_reminder_email',
    name: 'Appointment reminder',
    channel: 'EMAIL',
    locale: 'es',
    subject: 'Recordatorio: su cita de {{appointment_type}} el {{appointment_date}}',
    body: 'Hola {{first_name}}:\n\nLe recordamos su próxima cita de {{appointment_type}} el {{appointment_date}}. Si necesita cambiar la fecha, responda a este correo y buscaremos un mejor horario.\n\nHasta pronto,\n{{owner_name}}\n{{company_name}}',
    description: 'Recordatorio de cita (español).',
  },
  {
    key: 'appointment_reminder_sms',
    name: 'Appointment reminder (SMS)',
    channel: 'SMS',
    locale: 'en',
    subject: null,
    body: 'Hi {{first_name}}, reminder from {{company_name}}: your {{appointment_type}} appointment is on {{appointment_date}}. Need to reschedule? Just reply. Reply STOP to opt out.',
    description: 'SMS reminder for an upcoming appointment.',
  },
  {
    key: 'appointment_reminder_sms',
    name: 'Appointment reminder (SMS)',
    channel: 'SMS',
    locale: 'es',
    subject: null,
    body: 'Hola {{first_name}}, recordatorio de {{company_name}}: su cita de {{appointment_type}} es el {{appointment_date}}. ¿Necesita cambiarla? Responda a este mensaje. Responda STOP para no recibir más mensajes.',
    description: 'Recordatorio de cita por SMS (español).',
  },

  // Missing information
  {
    key: 'missing_info_email',
    name: 'Missing information',
    channel: 'EMAIL',
    locale: 'en',
    subject: 'One more thing needed on your {{document_name}}',
    body: 'Hi {{first_name}},\n\nWe reviewed your {{document_name}} and part of it is missing or unreadable. Could you send a complete, legible copy? A clear photo of every page works.\n\nThank you,\n{{owner_name}}\n{{company_name}}',
    description: 'A submitted document came back incomplete — request a corrected copy.',
  },
  {
    key: 'missing_info_email',
    name: 'Missing information',
    channel: 'EMAIL',
    locale: 'es',
    subject: 'Falta información en su {{document_name}}',
    body: 'Hola {{first_name}}:\n\nRevisamos su {{document_name}} y falta una parte o no se puede leer. ¿Podría enviarnos una copia completa y legible? Una foto clara de cada página es suficiente.\n\nGracias,\n{{owner_name}}\n{{company_name}}',
    description: 'Documento incompleto — pedir copia corregida (español).',
  },
  {
    key: 'missing_info_sms',
    name: 'Missing information (SMS)',
    channel: 'SMS',
    locale: 'en',
    subject: null,
    body: 'Hi {{first_name}}, {{company_name}} here. Your {{document_name}} is missing a part or is hard to read — could you resend a clear photo of every page? Reply STOP to opt out.',
    description: 'SMS nudge for an incomplete document.',
  },
  {
    key: 'missing_info_sms',
    name: 'Missing information (SMS)',
    channel: 'SMS',
    locale: 'es',
    subject: null,
    body: 'Hola {{first_name}}, le escribe {{company_name}}. A su {{document_name}} le falta una parte o no se lee bien. ¿Podría reenviar una foto clara de cada página? Responda STOP para no recibir más mensajes.',
    description: 'Documento incompleto por SMS (español).',
  },
]

export async function seedMessaging(db: PrismaClient, ctx: SeedCtx): Promise<void> {
  const author =
    ctx.users.find((u) => u.role === 'ADMIN') ?? ctx.users.find((u) => u.role === 'SUPER_ADMIN') ?? ctx.users[0]

  for (const t of TEMPLATES) {
    await db.messageTemplate.upsert({
      where: {
        organizationId_key_locale: { organizationId: ctx.organizationId, key: t.key, locale: t.locale },
      },
      update: {
        name: t.name,
        channel: t.channel,
        subject: t.subject,
        body: t.body,
        description: t.description,
        isActive: true,
      },
      create: {
        organizationId: ctx.organizationId,
        key: t.key,
        name: t.name,
        channel: t.channel,
        locale: t.locale,
        subject: t.subject,
        body: t.body,
        description: t.description,
        isActive: true,
        createdById: author?.id ?? null,
      },
    })
  }
}
