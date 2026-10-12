import type { Lang } from './types'

/**
 * Words for the host pieces (deep links, device notifications), English and
 * Spanish (formal usted, like the rest of the chat). Kept apart from
 * ./strings.ts so the host seam and the chat screen change independently.
 */
const EN = {
  noCaseChat: 'This lead has no team chat yet. It appears once a linked rep holds the lead.',
  noChannel: 'That conversation isn’t in your list.',
  notify: 'Notifications',
  notifyTitle: 'Notifications on this device',
  notifyOn: 'On',
  notifyOff: 'Off',
  notifyBody: 'Get a notification on this device when someone writes to you, even with ProdigyFlo closed.',
  notifyTest: 'Send a test',
  notifyTestSent: (n: number): string => (n > 0 ? 'Test sent. It should show up in a few seconds.' : 'No device answered. Turn notifications off and on again.'),
  notifyWorking: 'One moment…',
  notifyDenied: 'Notifications are blocked for ProdigyFlo in this browser. Allow them in the browser’s site settings, then try again.',
  notifyIos: 'On iPhone and iPad, add ProdigyFlo to your Home Screen first (Share › Add to Home Screen), then open it from there to turn on notifications.',
  notifyUnsupported: 'This browser can’t show notifications.',
  notifyOffServer: 'Notifications aren’t switched on for the team chat yet.',
  notifyFailed: 'That didn’t work. Please try again.',
  close: 'Close',
}

const ES: typeof EN = {
  noCaseChat: 'Este cliente aún no tiene chat del equipo. Aparece cuando un representante vinculado lo tiene asignado.',
  noChannel: 'Esa conversación no está en su lista.',
  notify: 'Avisos',
  notifyTitle: 'Avisos en este dispositivo',
  notifyOn: 'Activados',
  notifyOff: 'Apagados',
  notifyBody: 'Reciba un aviso en este dispositivo cuando alguien le escriba, aunque ProdigyFlo esté cerrado.',
  notifyTest: 'Enviar una prueba',
  notifyTestSent: (n: number) => (n > 0 ? 'Prueba enviada. Debería llegar en unos segundos.' : 'Ningún dispositivo respondió. Apague y vuelva a encender los avisos.'),
  notifyWorking: 'Un momento…',
  notifyDenied: 'Los avisos de ProdigyFlo están bloqueados en este navegador. Permítalos en la configuración del sitio y vuelva a intentarlo.',
  notifyIos: 'En iPhone y iPad, primero agregue ProdigyFlo a la pantalla de inicio (Compartir › Agregar a inicio) y ábralo desde ahí para activar los avisos.',
  notifyUnsupported: 'Este navegador no puede mostrar avisos.',
  notifyOffServer: 'Los avisos del chat del equipo aún no están activados.',
  notifyFailed: 'No funcionó. Inténtelo de nuevo.',
  close: 'Cerrar',
}

export type HostT = typeof EN

export function hostStrings(lang: Lang): HostT {
  return lang === 'es' ? ES : EN
}
