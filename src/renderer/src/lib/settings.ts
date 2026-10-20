import { useCallback, useEffect, useState } from 'react'

export type Settings = {
  showVersion: boolean
  alwaysOnTop: boolean
  /** Play `startup` shuffled when the app starts fresh (not when a restart resumes playback). */
  startupOn: boolean
  /** Kept when startupOn goes off, so turning it back on remembers the pick. */
  startup: { uri: string; name: string } | null
}

const DEFAULTS: Settings = {
  showVersion: true,
  alwaysOnTop: false,
  startupOn: false,
  startup: null
}

/** The settings page's choices, kept on this machine. */
export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState<Settings>(() => {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('settings') ?? '{}') }
    } catch {
      return DEFAULTS
    }
  })
  useEffect(() => localStorage.setItem('settings', JSON.stringify(settings)), [settings])
  const update = useCallback(
    (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })),
    []
  )
  return [settings, update]
}
