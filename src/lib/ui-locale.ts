export const PF_LOCALE_KEY = 'pf-locale'
export type UiLocale = 'en' | 'es'

export function parseLocale(raw: string | null | undefined): UiLocale {
  return raw === 'es' ? 'es' : 'en'
}

const listeners = new Set<() => void>()

export const uiLocaleStore = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    if (typeof window !== 'undefined') window.addEventListener('storage', listener)
    return () => {
      listeners.delete(listener)
      if (typeof window !== 'undefined') window.removeEventListener('storage', listener)
    }
  },
  get(): UiLocale {
    if (typeof window === 'undefined') return 'en'
    return parseLocale(localStorage.getItem(PF_LOCALE_KEY))
  },
  set(next: UiLocale) {
    const locale = parseLocale(next)
    if (typeof window === 'undefined') return
    if (locale === 'en') localStorage.removeItem(PF_LOCALE_KEY)
    else localStorage.setItem(PF_LOCALE_KEY, locale)
    document.documentElement.lang = locale === 'es' ? 'es' : 'en'
    listeners.forEach((l) => l())
  },
}

export function preferredLanguageCode(raw: string | undefined): string {
  const v = (raw ?? '').trim().toLowerCase()
  if (!v) return 'en'
  if (v === 'spanish' || v === 'es' || v.startsWith('es')) return 'es'
  if (v === 'english' || v === 'en' || v.startsWith('en')) return 'en'
  return v.slice(0, 2) || 'en'
}
