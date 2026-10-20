import { afterEach,beforeEach,expect,it,vi } from 'vitest'
const store=new Map<string,string>()
beforeEach(()=>{
 vi.resetModules();store.clear()
 vi.stubGlobal('localStorage',{getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>store.set(k,v),removeItem:(k:string)=>store.delete(k)})
 vi.stubGlobal('window',{addEventListener:vi.fn(),removeEventListener:vi.fn()})
 vi.stubGlobal('document',{documentElement:{lang:'en'}})
})
afterEach(()=>vi.unstubAllGlobals())
it('saves a choice, retries it after an offline failure, and never lends it to another user',async()=>{
 const fetch=vi.fn().mockRejectedValue(new Error('offline'));vi.stubGlobal('fetch',fetch)
 const {bindLocaleUser,uiLocaleStore,syncSavedLocale}=await import('./ui-locale')
 bindLocaleUser('one','en');uiLocaleStore.set('es');await syncSavedLocale()
 expect(uiLocaleStore.get()).toBe('es');expect(store.get('pf-locale:pending:one')).toBe('es')
 fetch.mockResolvedValue({ok:true,json:async()=>({})});await syncSavedLocale()
 expect(JSON.parse(fetch.mock.calls.at(-1)?.[1].body)).toEqual({userId:'one',language:'es'})
 expect(store.has('pf-locale:pending:one')).toBe(false)
 bindLocaleUser('two','en');expect(uiLocaleStore.get()).toBe('en')
})
it('takes the account choice on another device and ignores a stale response after account switching',async()=>{
 let resolve:(v:unknown)=>void=()=>{}
 vi.stubGlobal('fetch',vi.fn(()=>new Promise(r=>{resolve=r})))
 const {bindLocaleUser,uiLocaleStore,syncSavedLocale}=await import('./ui-locale')
 bindLocaleUser('one','es');expect(uiLocaleStore.get()).toBe('es')
 const p=syncSavedLocale();bindLocaleUser('two','en')
 resolve({ok:true,json:async()=>({userId:'one',language:'es'})});await p
 expect(uiLocaleStore.get()).toBe('en');expect(document.documentElement.lang).toBe('en')
})
