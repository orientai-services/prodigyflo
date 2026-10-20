"use client"
import { useEffect } from 'react'
import { bindLocaleUser, syncSavedLocale, type UiLocale } from '@/lib/ui-locale'
export function LocaleSync({userId,saved}:{userId:string;saved:UiLocale|null}){
  useEffect(()=>{
    bindLocaleUser(userId,saved)
    const refresh=()=>{if(document.visibilityState!=='hidden')void syncSavedLocale()}
    window.addEventListener('online',refresh)
    window.addEventListener('focus',refresh)
    document.addEventListener('visibilitychange',refresh)
    return()=>{window.removeEventListener('online',refresh);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh)}
  },[userId,saved])
  return null
}
