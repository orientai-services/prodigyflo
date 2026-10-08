'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  MIC_PREF_KEY,
  SPEAKER_PREF_KEY,
  concreteDevices,
  readAudioPref,
  resolveDeviceId,
  writeAudioPref,
} from '@/lib/telephony/ui/audio-prefs'

/**
 * Microphone and speaker pickers for browser calls.
 *
 * Only concrete devices are listed; "System default" resolves the OS's
 * default/communications alias to the real device at the moment it is
 * picked, so a headset reconnecting later doesn't silently move the call.
 *
 * Opening this panel never takes the microphone. The voice provider takes it
 * when a call starts and releases it when the call ends; the device list only
 * shows real names once the browser has been allowed to use the mic.
 */
export function AudioSettings() {
  // Rendered only after someone opens the phone settings, never on the
  // server, so reading the browser here is safe.
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [mic, setMic] = useState(() => readAudioPref(MIC_PREF_KEY) ?? '')
  const [speaker, setSpeaker] = useState(() => readAudioPref(SPEAKER_PREF_KEY) ?? '')
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
  const unsupported = !media?.enumerateDevices

  const list = useCallback(async (): Promise<MediaDeviceInfo[]> => {
    try {
      return (await media?.enumerateDevices()) ?? []
    } catch {
      return []
    }
  }, [media])

  useEffect(() => {
    if (!media) return
    let cancelled = false
    const refresh = () => {
      void list().then((found) => {
        if (!cancelled) setDevices(found)
      })
    }
    refresh()
    media.addEventListener?.('devicechange', refresh)
    return () => {
      cancelled = true
      media.removeEventListener?.('devicechange', refresh)
    }
  }, [list, media])

  const mics = concreteDevices(devices, 'audioinput')
  const speakers = concreteDevices(devices, 'audiooutput')
  const unnamed = mics.length > 0 && mics.every((d) => !d.label)

  // "System default" is pinned to the device the OS calls default right now;
  // when there is no alias to resolve it simply means "no preference".
  const choose = (key: string, kind: MediaDeviceKind, value: string, set: (v: string) => void) => {
    const id = value || resolveDeviceId('default', devices, kind)
    writeAudioPref(key, id)
    set(id ?? '')
  }

  if (unsupported) {
    return <p className="text-muted-foreground text-xs">This browser can&rsquo;t pick audio devices. It uses the system ones.</p>
  }

  return (
    <div className="grid gap-2 text-sm">
      <label className="grid gap-1">
        <span className="text-muted-foreground text-xs">Microphone</span>
        <select
          className="border-input bg-background h-8 rounded-md border px-2 text-sm"
          value={mics.some((d) => d.deviceId === mic) ? mic : ''}
          onChange={(e) => choose(MIC_PREF_KEY, 'audioinput', e.target.value, setMic)}
          aria-label="Microphone"
        >
          <option value="">System default</option>
          {mics.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {d.label || `Microphone ${i + 1}`}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1">
        <span className="text-muted-foreground text-xs">Speaker</span>
        <select
          className="border-input bg-background h-8 rounded-md border px-2 text-sm"
          value={speakers.some((d) => d.deviceId === speaker) ? speaker : ''}
          onChange={(e) => choose(SPEAKER_PREF_KEY, 'audiooutput', e.target.value, setSpeaker)}
          aria-label="Speaker"
          disabled={speakers.length === 0}
        >
          <option value="">System default</option>
          {speakers.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {d.label || `Speaker ${i + 1}`}
            </option>
          ))}
        </select>
      </label>
      {unnamed && (
        <p className="text-muted-foreground text-xs">Device names show after you allow the microphone once.</p>
      )}
      {speakers.length === 0 && (
        <p className="text-muted-foreground text-xs">This browser plays calls on the system speaker.</p>
      )}
    </div>
  )
}
