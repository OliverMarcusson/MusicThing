import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, Unauthorized, type PlaybackState, type Track } from './spotify'

// ponytail: polls /me/player; the Web API has no push channel for playback state.
const POLL_MS = 1500
// Spotify reports the old state for a moment after a command; ignore polls until it settles.
const SETTLE_MS = 1500
const SKIP_POLL_MS = 250
// How long after pressing "previous" a track change still counts as going back.
const BACK_WINDOW_MS = 5000
const HISTORY = 50

export type Player = ReturnType<typeof usePlayer>

export function usePlayer() {
  const [state, setState] = useState<PlaybackState | null>(null)
  const [syncedAt, setSyncedAt] = useState(() => Date.now())
  const [error, setError] = useState<unknown>(null)
  const lastCommand = useRef(0)
  // Bumped after queueing so an open queue view refetches.
  const [queueVersion, setQueueVersion] = useState(0)
  const deviceId = useRef<string | null>(null)
  // Which skip button was pressed last. Track ids alone can't tell next from previous when a
  // playlist repeats (A → B → A looks like "back" either way), so views read this instead.
  const lastSkip = useRef<{ dir: 'next' | 'previous'; at: number } | null>(null)

  // Tracks played this session, derived during render so Cover Flow moves the old centre cover
  // left in the same frame the new one arrives (an effect would leave a one-frame gap).
  // ponytail: session-only; Spotify's recently-played endpoint needs another scope and a re-login.
  const track = state?.item ?? null
  const [prevTrack, setPrevTrack] = useState(track)
  const [history, setHistory] = useState<Track[]>([])
  // Position of the current track in the play sequence; Cover Flow keys covers by it, so on a
  // skip the neighbour slides into the centre even when the same song sits on both sides.
  const [pos, setPos] = useState(0)
  if (track?.id !== prevTrack?.id) {
    // Only a recent press of "previous" moves backwards; skips, track ends and new picks go forward.
    const skip = lastSkip.current
    const back =
      skip?.dir === 'previous' &&
      Date.now() - skip.at < BACK_WINDOW_MS &&
      history.at(-1)?.id === track?.id
    setPrevTrack(track)
    setPos((p) => (back ? p - 1 : p + 1))
    setHistory((h) => (back ? h.slice(0, -1) : prevTrack ? [...h, prevTrack].slice(-HISTORY) : h))
  }

  // Playback always targets MusicThing's own player (librespot); looked up once, retried while missing.
  const device = useCallback(async () => {
    deviceId.current ??= await localDeviceId().catch(() => null)
    return deviceId.current
  }, [])

  const sync = useCallback(async () => {
    const startedAt = Date.now()
    try {
      const next = await api<PlaybackState>('/me/player')
      // Drop polls that started before, or too soon after, the latest command.
      if (startedAt < lastCommand.current + SETTLE_MS) return
      setState(next)
      setSyncedAt(startedAt)
      setError(null)
    } catch (err) {
      // Transient poll failures (429/5xx) are retried by the next poll; only surface auth loss.
      if (err instanceof Unauthorized) setError(err)
    }
  }, [])

  useEffect(() => {
    sync()
    const id = setInterval(() => !document.hidden && sync(), POLL_MS)
    document.addEventListener('visibilitychange', sync)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [sync])

  // Optimistically patch local state and send the command; polling resumes once Spotify settles.
  const command = useCallback(
    async (method: string, path: string, patch?: Partial<PlaybackState>) => {
      lastCommand.current = Date.now()
      if (patch) {
        setState((s) => (s ? { ...s, ...patch } : s))
        setSyncedAt(Date.now())
      }
      try {
        await api(path, { method })
        lastCommand.current = Date.now()
      } catch (err) {
        setError(err)
        if (err instanceof ApiError && err.status === 404) deviceId.current = null
        lastCommand.current = 0
        sync()
      }
    },
    [sync]
  )

  // Track changes can't be patched optimistically (we don't know the next track), so poll fast
  // until Spotify reports a different track or a restarted one, instead of waiting out SETTLE_MS.
  const changeTrack = useCallback(
    async (method: string, path: string, body?: object) => {
      const before = state
      const beforeProgress = before ? progressAt(before, syncedAt) : 0
      lastCommand.current = Date.now()
      try {
        await api(path, {
          method,
          ...(body && {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          })
        })
      } catch (err) {
        setError(err)
        if (err instanceof ApiError && err.status === 404) deviceId.current = null
        lastCommand.current = 0
        return sync()
      }
      for (let i = 0; i < 12; i++) {
        lastCommand.current = Date.now()
        await new Promise((r) => setTimeout(r, SKIP_POLL_MS))
        const startedAt = Date.now()
        const next = await api<PlaybackState>('/me/player').catch(() => null)
        const changed =
          next?.item?.id !== before?.item?.id ||
          (beforeProgress > 3000 && (next?.progress_ms ?? 0) < 2000)
        if (next && changed) {
          setState(next)
          setSyncedAt(startedAt)
          setError(null)
          break
        }
      }
      lastCommand.current = 0
    },
    [state, syncedAt, sync]
  )

  /**
   * Cover Flow's batched skip: one command per track, then a single state update that also records
   * the passed tracks, so history and position move by `n` at once instead of through every
   * intermediate track. Resolves false if Spotify never reached `target`.
   */
  const skipBy = useCallback(
    async (n: number, passed: Track[], target: Track): Promise<boolean> => {
      lastCommand.current = Date.now()
      lastSkip.current = { dir: n > 0 ? 'next' : 'previous', at: Date.now() }
      try {
        // "Previous" mid-song restarts it; from the top it steps back a track.
        if (n < 0) await api('/me/player/seek?position_ms=0', { method: 'PUT' })
        for (let i = 0; i < Math.abs(n); i++) {
          lastCommand.current = Date.now()
          await api(`/me/player/${n > 0 ? 'next' : 'previous'}`, { method: 'POST' })
        }
      } catch (err) {
        setError(err)
        lastCommand.current = 0
        sync()
        return false
      }
      for (let i = 0; i < 16; i++) {
        lastCommand.current = Date.now()
        await new Promise((r) => setTimeout(r, SKIP_POLL_MS))
        const startedAt = Date.now()
        const next = await api<PlaybackState>('/me/player').catch(() => null)
        if (next?.item?.uri !== target.uri) continue
        // Same batch as setState, so the render-time history derivation sees no change of its own.
        setPrevTrack(next.item)
        setHistory((h) => (n > 0 ? [...h, ...passed].slice(-HISTORY) : h.slice(0, n)))
        setPos((p) => p + n)
        setState(next)
        setSyncedAt(startedAt)
        setError(null)
        lastCommand.current = 0
        return true
      }
      lastCommand.current = 0
      sync()
      return false
    },
    [sync]
  )

  return {
    skipBy,
    state,
    syncedAt,
    error,
    toggle: async () => {
      const progress = state ? { progress_ms: progressAt(state, syncedAt) } : {}
      if (state?.is_playing)
        return command('PUT', '/me/player/pause', { is_playing: false, ...progress })
      // device_id also pulls playback here if it was active elsewhere or idle.
      const id = await device()
      return command(
        'PUT',
        `/me/player/play${id ? `?device_id=${id}` : ''}`,
        state ? { is_playing: true, ...progress } : undefined
      )
    },
    lastSkip,
    history,
    pos,
    next: () => {
      lastSkip.current = { dir: 'next', at: Date.now() }
      return changeTrack('POST', '/me/player/next')
    },
    previous: () => {
      lastSkip.current = { dir: 'previous', at: Date.now() }
      return changeTrack('POST', '/me/player/previous')
    },
    /** Start a track inside a playlist/album context, or from an explicit list of track URIs. */
    play: async (
      target:
        | { context_uri: string; offset?: { uri: string } }
        | { uris: string[]; offset: { uri: string } }
    ) => {
      const id = await device()
      return changeTrack('PUT', `/me/player/play${id ? `?device_id=${id}` : ''}`, target)
    },
    queueVersion,
    /** After the queue or track changed outside the Web API (Connect commands). */
    refreshQueue: () => {
      setQueueVersion((v) => v + 1)
      sync()
    },
    addToQueue: async (uri: string) => {
      const id = await device()
      await api(`/me/player/queue?${new URLSearchParams({ uri, ...(id && { device_id: id }) })}`, {
        method: 'POST'
      })
      setQueueVersion((v) => v + 1)
    },
    /** Shuffle and repeat apply to MusicThing's player; the queue refetches to show the new order. */
    setShuffle: async (on: boolean) => {
      const id = await device()
      await command('PUT', `/me/player/shuffle?state=${on}${id ? `&device_id=${id}` : ''}`, {
        shuffle_state: on
      })
      setQueueVersion((v) => v + 1)
    },
    setRepeat: async (mode: PlaybackState['repeat_state']) => {
      const id = await device()
      await command('PUT', `/me/player/repeat?state=${mode}${id ? `&device_id=${id}` : ''}`, {
        repeat_state: mode
      })
      setQueueVersion((v) => v + 1)
    },
    seek: (ms: number) =>
      command('PUT', `/me/player/seek?position_ms=${Math.round(ms)}`, { progress_ms: ms }),
    setVolume: (percent: number) =>
      state &&
      command('PUT', `/me/player/volume?volume_percent=${Math.round(percent)}`, {
        device: { ...state.device, volume_percent: percent }
      })
  }
}

// Interpolates playback position between polls.
export function progressAt(state: PlaybackState, syncedAt: number, now = Date.now()): number {
  const base = state.progress_ms ?? 0
  const elapsed = state.is_playing ? now - syncedAt : 0
  return Math.min(base + elapsed, state.item?.duration_ms ?? base)
}

// The name src/main/librespot.ts registers the player under.
async function localDeviceId(): Promise<string | null> {
  const res = await api<{ devices: { id: string | null; name: string }[] }>('/me/player/devices')
  return res?.devices.find((d) => d.name === 'MusicThing')?.id ?? null
}
