/**
 * The viewer's microphone and speaker choice for browser calls.
 *
 * Kept in localStorage per browser (a convenience, not a record), and every
 * read and write is wrapped: private windows and blocked site data throw, and
 * calling must still work with the system defaults when they do.
 */

export const MIC_PREF_KEY = 'pf-voice-mic'
export const SPEAKER_PREF_KEY = 'pf-voice-speaker'

export function readAudioPref(key: string): string | null {
  try {
    const value = window.localStorage.getItem(key)
    return value && value !== 'default' && value !== 'communications' ? value : null
  } catch {
    return null
  }
}

export function writeAudioPref(key: string, value: string | null): void {
  try {
    if (value) window.localStorage.setItem(key, value)
    else window.localStorage.removeItem(key)
  } catch {
    // Not saved; the choice still applies for this page.
  }
}

/**
 * Chrome and Edge on Windows list two pseudo-devices, "default" and
 * "communications", whose labels read "Default - Headset (…)" and
 * "Communications - Headset (…)". Picking one of them follows whatever the OS
 * switches to later, which is how a call ends up on the laptop speaker when a
 * headset reconnects. Resolve them to the concrete device by label so the
 * choice stays put.
 */
export function concreteDevices(devices: MediaDeviceInfo[], kind: MediaDeviceKind): MediaDeviceInfo[] {
  return devices.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications')
}

export function resolveDeviceId(id: string, devices: MediaDeviceInfo[], kind: MediaDeviceKind): string | null {
  const ofKind = devices.filter((d) => d.kind === kind)
  if (id !== 'default' && id !== 'communications') {
    return ofKind.some((d) => d.deviceId === id) ? id : null
  }
  const alias = ofKind.find((d) => d.deviceId === id)
  if (!alias) return null
  const label = alias.label.replace(/^(Default|Communications)\s*-\s*/i, '').trim()
  const match = concreteDevices(devices, kind).find((d) => d.label.trim() === label)
  return match?.deviceId ?? null
}

/** The stored choice, if that device is still plugged in. */
export async function storedDeviceId(key: string, kind: MediaDeviceKind): Promise<string | null> {
  const stored = readAudioPref(key)
  if (!stored || typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return null
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return resolveDeviceId(stored, devices, kind)
  } catch {
    return null
  }
}
