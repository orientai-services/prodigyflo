export const PF_LOCALE_KEY = 'pf-locale'
export type UiLocale = 'en' | 'es'

export function parseLocale(raw: string | null | undefined): UiLocale {
  return raw === 'es' ? 'es' : 'en'
}

// Private browsing can deny storage. Keep the current session usable and save online.
const memory=new Map<string,string>()
const storage={
 getItem(key:string):string|null{try{return localStorage.getItem(key)}catch{return memory.get(key) ?? null}},
 setItem(key:string,value:string){memory.set(key,value);try{localStorage.setItem(key,value)}catch{/* session fallback */}},
 removeItem(key:string){memory.delete(key);try{localStorage.removeItem(key)}catch{/* session fallback */}},
}
const listeners = new Set<() => void>()
let currentUser: string | null = null
let saving: Promise<void> | null = null
const storageKey=()=>currentUser ? `${PF_LOCALE_KEY}:${currentUser}` : PF_LOCALE_KEY
const pendingKey=(id:string)=>`${PF_LOCALE_KEY}:pending:${id}`
function paint(locale:UiLocale){document.documentElement.lang=locale;listeners.forEach(l=>l())}
async function flushLanguage():Promise<void>{
  if(saving)return saving
  saving=(async()=>{
    while(currentUser){
      const id=currentUser, pending=storage.getItem(pendingKey(id))
      if(pending!=='en' && pending!=='es')break
      try{
        const r=await fetch('/api/me/language',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:id,language:pending})})
        if(!r.ok)break
        if(currentUser!==id)break
        if(storage.getItem(pendingKey(id))===pending)storage.removeItem(pendingKey(id))
      }catch{break}
    }
  })().finally(()=>{saving=null})
  return saving
}
export function bindLocaleUser(id:string,saved:UiLocale|null){
  const previous=storage.getItem(`${PF_LOCALE_KEY}:user`)
  currentUser=id
  const scoped=storage.getItem(storageKey()), pending=storage.getItem(pendingKey(id))
  const legacy=!previous || previous===id ? storage.getItem(PF_LOCALE_KEY) : null
  const locale=parseLocale(pending || saved || scoped || legacy)
  storage.setItem(`${PF_LOCALE_KEY}:user`,id)
  storage.setItem(storageKey(),locale)
  paint(locale)
  if(pending || saved===null){storage.setItem(pendingKey(id),locale);if(saving)void saving.then(()=>flushLanguage());else void flushLanguage()}
}
export async function syncSavedLocale(){
  if(!currentUser)return
  if(storage.getItem(pendingKey(currentUser))){await flushLanguage();return}
  const id=currentUser
  try{
    const r=await fetch('/api/me/language',{cache:'no-store'})
    if(!r.ok)return
    const body=await r.json()
    if(id!==currentUser || body.userId!==id || storage.getItem(pendingKey(id)))return
    if(body.language==='en' || body.language==='es'){storage.setItem(storageKey(),body.language);paint(body.language)}
  }catch{/* local preference remains available offline */}
}

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
    return parseLocale(storage.getItem(storageKey()))
  },
  set(next: UiLocale) {
    const locale = parseLocale(next)
    if (typeof window === 'undefined') return
    storage.setItem(storageKey(), locale)
    paint(locale)
    if(currentUser){storage.setItem(pendingKey(currentUser),locale);void flushLanguage()}
  },
}

export function preferredLanguageCode(raw: string | undefined): string {
  const v = (raw ?? '').trim().toLowerCase()
  if (!v) return 'en'
  if (v === 'spanish' || v === 'es' || v.startsWith('es')) return 'es'
  if (v === 'english' || v === 'en' || v.startsWith('en')) return 'en'
  return v.slice(0, 2) || 'en'
}
