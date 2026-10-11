/**
 * Reminder copy. ES path is built but unused until the Spanish Page connects.
 * No promises or guarantees in client copy.
 */
export type CalendarLanguage = 'EN' | 'ES'

const COPY = {
  EN: {
    clientSubject: (when: string) => `Reminder: your home visit ${when}`,
    clientBody: (when: string, rep: string) =>
      `Hi, this is a reminder that ${rep} is scheduled to visit you ${when} (about 90 minutes). Reply or call us if you need to change the time.`,
    repSubject: (when: string) => `Call Center visit ${when}`,
    repBody: (when: string, leadRef: string) => `You have a Call Center home visit ${when}. Lead: ${leadRef}.`,
  },
  ES: {
    clientSubject: (when: string) => `Recordatorio: su visita a domicilio ${when}`,
    clientBody: (when: string, rep: string) =>
      `Hola, le recordamos que ${rep} tiene programada una visita ${when} (unos 90 minutos). Responda o llámenos si necesita cambiar la hora.`,
    repSubject: (when: string) => `Visita del Call Center ${when}`,
    repBody: (when: string, leadRef: string) => `Tiene una visita del Call Center ${when}. Lead: ${leadRef}.`,
  },
} as const

export function calendarCopy(language: CalendarLanguage) {
  return COPY[language] ?? COPY.EN
}

export function formatVisitTime(at: Date, language: CalendarLanguage): string {
  return new Intl.DateTimeFormat(language === 'ES' ? 'es-US' : 'en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(at)
}
