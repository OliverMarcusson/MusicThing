import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, ApiError, Unauthorized, type PlaybackState, type Track } from './spotify'

// Playback state is pushed over Spotify Connect (main/connect.ts `watch`); the Web API only
// sends commands and fills in track details.
// How long a batched skip waits for Spotify to report its target track.
const SKIP_WAIT_MS = 4000
// How long after pressing "previous" a track change still counts as going back.
const BACK_WINDOW_MS = 5000
const HISTORY = 50
// Songs kept on the History page.
const RECENT = 50
// How close to its end a track must be for a stop to count as the playlist running out.
const END_MARGIN_MS = 4000

export type Player = ReturnType<typeof usePlayer>

export function usePlayer() {
  const [state, setState] = useState<PlaybackState | null>(null)
  const [syncedAt, setSyncedAt] = useState(() => Date.now())
  const [error, setError] = useState<unknown>(null)
  // Bumped after queueing so an open queue view refetches.
  const [queueVersion, setQueueVersion] = useState(0)
  const deviceId = useRef<string | null>(null)
  // Spotify Connect devices the user can play on, from the latest push.
  const [devices, setDevices] = useState<{ id: string; name: string; type?: string }[]>([])
  // Which skip button was pressed last. Track ids alone can't tell next from previous when a
  // playlist repeats (A → B → A looks like "back" either way), so views read this instead.
  const lastSkip = useRef<{ dir: 'next' | 'previous'; at: number } | null>(null)
  // What's on screen, for sync (a stable callback) to compare the next poll against.
  const shown = useRef({ state, syncedAt })
  useLayoutEffect(() => {
    shown.current = { state, syncedAt }
  })
  // The track a finished playlist stopped on; hidden until playback starts again.
  const ended = useRef<string | null>(null)
  // A track change that may be that stop, until its pause shows up or the window passes.
  const stopping = useRef<{ id: string | null; until: number } | null>(null)

  // Tracks played this session, derived during render so Cover Flow moves the old centre cover
  // left in the same frame the new one arrives (an effect would leave a one-frame gap).
  // ponytail: session-only; Spotify's recently-played endpoint needs another scope and a re-login.
  const track = state?.item ?? null
  const [prevTrack, setPrevTrack] = useState(track)
  const [history, setHistory] = useState<Track[]>([])
  // Position of the current track in the play sequence; Cover Flow keys covers by it, so on a
  // skip the neighbour slides into the centre even when the same song sits on both sides.
  const [pos, setPos] = useState(0)
  // The History page: the last songs played, newest first, each once. Unlike `history` it
  // outlives restarts and context changes; recorded below as each track starts.
  const [recent, setRecent] = useState<Track[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('recent') ?? '[]')
    } catch {
      return []
    }
  })
  useEffect(() => localStorage.setItem('recent', JSON.stringify(recent)), [recent])
  // Starting another playlist or album starts a fresh run, so nothing sits before its first song.
  // A context-less moment (stopped, between devices) isn't a change.
  const context = state?.context?.uri ?? null
  const [prevContext, setPrevContext] = useState(context)
  const fresh = context !== null && context !== prevContext
  if (fresh) setPrevContext(context)
  if (fresh && track?.id === prevTrack?.id) setHistory([])
  if (track?.id !== prevTrack?.id) {
    // Only a recent press of "previous" moves backwards; skips, track ends and new picks go forward.
    const skip = lastSkip.current
    const back =
      skip?.dir === 'previous' &&
      Date.now() - skip.at < BACK_WINDOW_MS &&
      history.at(-1)?.id === track?.id
    setPrevTrack(track)
    setPos((p) => (back ? p - 1 : p + 1))
    setHistory((h) =>
      fresh ? [] : back ? h.slice(0, -1) : prevTrack ? [...h, prevTrack].slice(-HISTORY) : h
    )
    if (track) setRecent((r) => [track, ...r.filter((t) => t.id !== track.id)].slice(0, RECENT))
  }

  // Commands go to the device that's playing, picked in the Connect menu; with none, to
  // MusicThing's own player (librespot), looked up once and retried while missing.
  const device = useCallback(async () => {
    const active = shown.current.state?.device.id
    if (active) return active
    deviceId.current ??= await localDeviceId().catch(() => null)
    return deviceId.current
  }, [])

  // A playlist that runs out without repeat stops on its first track, paused at 0:00, which
  // Spotify reports just like a paused track. Catch it in two parts: a playing track gives way to
  // another (at its end, or on "next"), and soon after, that one shows paused at the start. Spotify
  // can report the new track as still playing for a moment, so the pause may come a poll later.
  // ponytail: "next" on the last track while paused can't be told from an ordinary skip.
  const show = useCallback((next: PlaybackState | null, startedAt: number) => {
    const prev = shown.current
    const item = next?.item
    const skipped =
      lastSkip.current?.dir === 'next' && startedAt - lastSkip.current.at < BACK_WINDOW_MS
    if (
      prev.state?.is_playing &&
      prev.state.repeat_state === 'off' &&
      item &&
      item.id !== prev.state.item?.id &&
      (skipped ||
        progressAt(prev.state, prev.syncedAt, startedAt) >=
          (prev.state.item?.duration_ms ?? Infinity) - END_MARGIN_MS)
    )
      stopping.current = { id: item.id, until: startedAt + BACK_WINDOW_MS }
    const s = stopping.current
    if (
      s &&
      startedAt < s.until &&
      item?.id === s.id &&
      !next?.is_playing &&
      (next?.progress_ms ?? 0) < 1000
    ) {
      ended.current = s.id
      stopping.current = null
    }
    if (ended.current && (next?.is_playing || item?.id !== ended.current)) ended.current = null
    setState(ended.current ? null : next)
  }, [])

  // Pushes are applied in order, even though a new track's details take a moment to fetch.
  const latest = useRef(0)
  // A batched skip waiting for its target; pushes before it are tracks passed on the way.
  const awaiting = useRef<{ uri: string; done: (s: PlaybackState, at: number) => void } | null>(
    null
  )
  // Re-reads the state; the answer arrives as a push.
  const refresh = useCallback(async () => {
    const r = await window.api.connectWatch()
    if ('error' in r && r.error === 'signin') setError(new Unauthorized())
  }, [])

  useEffect(() => {
    async function apply(c: Cluster): Promise<void> {
      const seq = ++latest.current
      const at = Date.now()
      // The hidden device main/connect.ts sends commands from has no name.
      setDevices(
        Object.entries(c.devices ?? {})
          .filter(([, d]) => d.name)
          .map(([id, d]) => ({ id, name: d.name, type: d.device_type }))
      )
      const next = await toState(c)
      if (seq !== latest.current) return
      const wait = awaiting.current
      if (wait) {
        if (next?.item?.uri !== wait.uri) return
        awaiting.current = null
        return wait.done(next, at)
      }
      show(next, at)
      setSyncedAt(at)
      setError(null)
      // Once a slow lookup answers, show the real details (unless a newer push came first).
      const late = next?.item && standIns.get(next.item)
      late?.then((t) => {
        if (t && seq === latest.current) apply(c)
      })
    }
    const off = window.api.onCluster(apply)
    refresh()
    return off
  }, [show, refresh])

  // Optimistically patch local state and send the command; the push that follows confirms it.
  const command = useCallback(
    async (method: string, path: string, patch?: Partial<PlaybackState>) => {
      if (patch) {
        setState((s) => (s ? { ...s, ...patch } : s))
        setSyncedAt(Date.now())
      }
      try {
        await api(path, { method })
      } catch (err) {
        setError(err)
        if (err instanceof ApiError && err.status === 404) deviceId.current = null
        refresh()
      }
    },
    [refresh]
  )

  // Track changes can't be patched optimistically (we don't know the next track); the push shows it.
  const changeTrack = useCallback(
    async (method: string, path: string, body?: object) => {
      // Starting something leaves a finished playlist behind.
      ended.current = null
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
        refresh()
      }
    },
    [refresh]
  )

  /**
   * Cover Flow's batched skip: one command per track, then a single state update that also records
   * the passed tracks, so history and position move by `n` at once instead of through every
   * intermediate track. Resolves false if Spotify never reached `target`.
   */
  const skipBy = useCallback(
    async (n: number, passed: Track[], target: Track): Promise<boolean> => {
      lastSkip.current = { dir: n > 0 ? 'next' : 'previous', at: Date.now() }
      let entry: typeof awaiting.current = null
      const reached = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          if (awaiting.current === entry) awaiting.current = null
          resolve(false)
        }, SKIP_WAIT_MS)
        entry = {
          uri: target.uri,
          done: (next, at) => {
            clearTimeout(timer)
            // Same batch as setState, so the render-time history derivation sees no change of its own.
            setPrevTrack(next.item)
            setHistory((h) => (n > 0 ? [...h, ...passed].slice(-HISTORY) : h.slice(0, n)))
            setPos((p) => p + n)
            setState(next)
            setSyncedAt(at)
            setError(null)
            resolve(true)
          }
        }
        awaiting.current = entry
      })
      try {
        // One Connect batch lands exactly; the Web API's one-command-per-track is the fallback
        // (the queue moved since Cover Flow drew it).
        if (!('ok' in (await window.api.connectSkipBy(n, target.uri)))) {
          // "Previous" mid-song restarts it; from the top it steps back a track.
          if (n < 0) await api('/me/player/seek?position_ms=0', { method: 'PUT' })
          for (let i = 0; i < Math.abs(n); i++)
            await api(`/me/player/${n > 0 ? 'next' : 'previous'}`, { method: 'POST' })
        }
      } catch (err) {
        if (awaiting.current === entry) awaiting.current = null
        setError(err)
        refresh()
        return false
      }
      if (await reached) return true
      refresh()
      return false
    },
    [refresh]
  )

  return {
    skipBy,
    devices,
    /** Moves playback to another Connect device; the push that follows shows it. */
    transfer: async (id: string) => {
      const r = await window.api.connectTransfer(id)
      if ('error' in r) {
        setError(r.error === 'signin' ? new Unauthorized() : new Error(r.message))
        refresh()
      }
    },
    state,
    syncedAt,
    error,
    toggle: async () => {
      const progress = state ? { progress_ms: progressAt(state, syncedAt) } : {}
      if (state?.is_playing)
        return command('PUT', '/me/player/pause', { is_playing: false, ...progress })
      // device_id wakes the playing device, or MusicThing's player when idle.
      const id = await device()
      return command(
        'PUT',
        `/me/player/play${id ? `?device_id=${id}` : ''}`,
        state ? { is_playing: true, ...progress } : undefined
      )
    },
    lastSkip,
    history,
    recent,
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
      // The Web API's queue trails Connect by up to ~750ms (measured); fetching sooner returns the
      // old order, which snaps a dropped row back before it lands.
      setTimeout(() => setQueueVersion((v) => v + 1), 1000)
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

type Cluster = Parameters<Parameters<typeof window.api.onCluster>[0]>[0]

// Connect names cover art spotify:image:<id>.
const imageUrlFrom = (uri?: string): string | undefined =>
  uri?.startsWith('spotify:image:') ? `https://i.scdn.co/image/${uri.slice(14)}` : uri

// One lookup per track, shared by every push that shows it. A failed one is retried after a
// minute at the earliest: while rate-limited, each request only pushes the limit further out.
const tracks = new Map<string, Promise<Track | null>>()
// Stand-ins for tracks whose lookup hadn't answered yet, with that lookup.
const standIns = new WeakMap<Track, Promise<Track | null>>()

/**
 * Connect only sends a track's uri and some metadata, so the rest comes from the Web API. If that's
 * slow (rate-limited), Connect's own metadata stands in; see `standIns`.
 */
async function trackFor(
  uri: string,
  meta: Record<string, string> = {},
  duration: number
): Promise<Track | null> {
  const id = uri.match(/^spotify:track:(\w+)$/)?.[1]
  if (!id) return null
  let fetched = tracks.get(id)
  if (!fetched) {
    fetched = api<Track>(`/tracks/${id}`)
      .catch(() => null)
      .then((t) => {
        if (!t) setTimeout(() => tracks.delete(id), 60_000)
        return t
      })
    tracks.set(id, fetched)
  }
  const t = await Promise.race([fetched, new Promise<null>((r) => setTimeout(r, 2000, null))])
  if (t) return t
  const art = imageUrlFrom(meta.image_large_url ?? meta.image_url)
  const standIn: Track = {
    id,
    uri,
    name: meta.title ?? '',
    duration_ms: duration,
    artists: meta.artist_name ? [{ name: meta.artist_name }] : [],
    album: { name: meta.album_title ?? '', images: art ? [{ url: art, width: 640 }] : [] }
  }
  standIns.set(standIn, fetched)
  return standIn
}

/** The Web API's /me/player shape, built from a Connect cluster. */
async function toState(c: Cluster): Promise<PlaybackState | null> {
  const p = c.player_state
  if (!c.active_device_id || !p?.track?.uri) return null
  const duration = Number(p.duration ?? 0)
  const playing = !!p.is_playing && !p.is_paused
  // Position as of the push, from Spotify's clock on both ends so local clock skew can't creep in.
  const elapsed = playing
    ? Number(c.server_timestamp_ms ?? p.timestamp ?? 0) - Number(p.timestamp ?? 0)
    : 0
  const device = c.devices?.[c.active_device_id]
  return {
    is_playing: playing,
    progress_ms: Math.min(
      Number(p.position_as_of_timestamp ?? 0) + Math.max(0, elapsed),
      duration || Infinity
    ),
    shuffle_state: !!p.options?.shuffling_context,
    repeat_state: p.options?.repeating_track
      ? 'track'
      : p.options?.repeating_context
        ? 'context'
        : 'off',
    item: await trackFor(p.track.uri, p.track.metadata, duration),
    context: p.context_uri ? { uri: p.context_uri } : null,
    device: {
      id: c.active_device_id,
      name: device?.name ?? '',
      // Connect volume runs 0-65535, and a muted device's is left out (zeroes are), which mustn't
      // read as a device without volume control: that disabled the slider at 0, stuck muted.
      volume_percent: device ? Math.round((device.volume ?? 0) / 655.35) : null
    }
  }
}

// Interpolates playback position between pushes.
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
