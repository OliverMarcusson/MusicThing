import { randomBytes } from 'crypto'
import { gunzipSync } from 'zlib'
import { SignedOut, webAuth } from './webplayer'

/**
 * Queue editing through Spotify Connect's private API, the one the official apps use; the Web API
 * can only append to the queue. Commands need a sending device, so a hidden one that never plays
 * is registered on a dealer socket. Auth is the signed-in web player's (see webplayer.ts).
 *
 * The same socket pushes the playback state whenever it changes (`watch`), which is how the
 * player follows playback without polling the Web API's /me/player.
 *
 * Can break whenever Spotify changes the protocol.
 */

// ponytail: one fixed region; resolve hosts through apresolve.spotify.com if this one stops answering.
const SPCLIENT = 'https://gew4-spclient.spotify.com'
const DEALER = 'wss://gew4-dealer.g2.spotify.com/'
const DEVICE_ID = randomBytes(20).toString('hex')
const REGISTER = {
  member_type: 'CONNECT_STATE',
  device: {
    device_info: {
      capabilities: { can_be_player: false, hidden: true, needs_full_player_state: true }
    }
  }
}

type QueueItem = { uri: string; uid: string; provider?: string; metadata?: Record<string, string> }
/** Spotify's view of playback across devices. Longs arrive as strings. */
export type Cluster = {
  active_device_id: string
  server_timestamp_ms?: string
  devices?: Record<string, { name: string; volume?: number; device_type?: string }>
  player_state: {
    queue_revision: string
    next_tracks: QueueItem[]
    prev_tracks: QueueItem[]
    track?: QueueItem
    /** The playlist, album etc. playing from. */
    context_uri?: string
    timestamp?: string
    position_as_of_timestamp?: string
    duration?: string
    is_playing?: boolean
    is_paused?: boolean
    options?: {
      shuffling_context?: boolean
      repeating_context?: boolean
      repeating_track?: boolean
    }
  }
}
export type ConnectResult<T> = { ok: T } | { error: 'signin' | 'failed'; message: string }

class Unauthorized extends Error {}

let watcher: ((c: Cluster) => void) | null = null
let jamWatcher: (() => void) | null = null
let retry: ReturnType<typeof setTimeout> | undefined
// Registering again is what resubscribes, after the socket drops or a registration fails.
function resubscribe(): void {
  clearTimeout(retry)
  retry = setTimeout(async () => {
    const r = await op(cluster)
    if ('error' in r && r.error === 'failed') resubscribe()
  }, 5000)
}

// Cluster pushes; big ones come gzipped and base64-encoded instead of as plain JSON.
function onPush(msg: {
  uri?: string
  headers?: Record<string, string>
  payloads?: unknown[]
}): void {
  // Jam changes are only a nudge; the session is read again (see `jam`).
  if (msg.uri?.endsWith('social-connect/v2/session_update')) return jamWatcher?.()
  if (msg.uri !== 'hm://connect-state/v1/cluster') return
  for (const p of msg.payloads ?? []) {
    try {
      const raw = Buffer.from(String(p), 'base64')
      const update =
        typeof p === 'string'
          ? JSON.parse(
              String(msg.headers?.['Transfer-Encoding'] === 'gzip' ? gunzipSync(raw) : raw)
            )
          : p
      if (update?.cluster) watcher?.(update.cluster)
    } catch (err) {
      console.error('Unreadable Spotify Connect push:', err)
    }
  }
}

// The dealer socket's first message carries the connection id that device registration needs.
let connection: Promise<string> | null = null
let dealer: WebSocket | null = null
function connect(token: string): Promise<string> {
  connection ??= new Promise((resolve, reject) => {
    const ws = new WebSocket(`${DEALER}?access_token=${encodeURIComponent(token)}`)
    const ping = setInterval(
      () => ws.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'),
      30_000
    )
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data))
      const id = msg.headers?.['Spotify-Connection-Id']
      if (id) resolve(id)
      else onPush(msg)
    }
    ws.onclose = () => {
      clearInterval(ping)
      if (dealer === ws) {
        connection = null
        if (watcher) resubscribe()
      }
      reject(new Error('Spotify Connect closed the connection'))
    }
    dealer = ws
  })
  return connection
}

async function call(path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(SPCLIENT + path, {
    ...init,
    headers: {
      ...(await webAuth()),
      'content-type': 'application/json',
      accept: 'application/json',
      ...init.headers
    }
  })
  if (res.status === 401) throw new Unauthorized()
  if (!res.ok) throw new Error(`Spotify Connect answered ${res.status}`)
  return res
}

// Registering again is also how the full, current state is read.
async function cluster(): Promise<Cluster> {
  const { authorization } = await webAuth()
  const id = await connect(authorization.replace(/^Bearer /, ''))
  const res = await call(`/connect-state/v1/devices/hobs_${DEVICE_ID}`, {
    method: 'PUT',
    headers: { 'x-spotify-connection-id': id },
    body: JSON.stringify(REGISTER)
  })
  const c: Cluster = await res.json()
  watcher?.(c)
  return c
}

async function send(
  c: Cluster,
  command: Record<string, unknown>,
  to = c.active_device_id
): Promise<Response> {
  try {
    return await call(`/connect-state/v1/player/command/from/${DEVICE_ID}/to/${to}`, {
      method: 'POST',
      body: JSON.stringify({
        command: { ...command, logging_params: { command_id: randomBytes(16).toString('hex') } }
      })
    })
  } catch (err) {
    // The cluster keeps the last queue after playback stops, but no device is left to take commands.
    if (err instanceof Error && err.message.endsWith('404'))
      throw new Error('Nothing is playing; start a song to edit the queue.')
    throw err
  }
}

// One operation at a time, each on fresh state, so quick drags can't race on a stale revision.
let chain: Promise<unknown> = Promise.resolve()
function op<T>(fn: () => Promise<T>): Promise<ConnectResult<T>> {
  const run = async (): Promise<ConnectResult<T>> => {
    try {
      try {
        return { ok: await fn() }
      } catch (err) {
        if (!(err instanceof Unauthorized)) throw err
        // Expired token: fetch a new one, reconnect with it, and try once more.
        await webAuth(true)
        dealer?.close()
        connection = null
        return { ok: await fn() }
      }
    } catch (err) {
      if (err instanceof SignedOut)
        return { error: 'signin', message: 'Sign in to Spotify to edit the queue.' }
      return { error: 'failed', message: err instanceof Error ? err.message : String(err) }
    }
  }
  const result = chain.then(run)
  chain = result
  return result
}

/**
 * Sends the playback state to `cb` now and on every change. Calling it again re-reads the state,
 * which is also how a 'signin' result is retried after signing in.
 */
export async function watch(cb: (c: Cluster) => void): Promise<ConnectResult<true>> {
  watcher = cb
  const r = await op(async () => {
    await cluster()
    return true as const
  })
  if ('error' in r && r.error === 'failed') resubscribe()
  return r
}

/** The current state across devices. */
export const state = (): Promise<ConnectResult<Cluster>> => op(cluster)

/**
 * Sends one player command (endpoint names as the official apps use them) to `to`, or to the
 * device that's playing.
 */
export const command = (cmd: Record<string, unknown>, to?: string): Promise<ConnectResult<true>> =>
  op(async () => {
    await send(await cluster(), cmd, to)
    return true as const
  })

/** Moves playback to `to` and keeps it playing. */
export const transfer = (to: string): Promise<ConnectResult<true>> =>
  op(async () => {
    await cluster()
    await call(`/connect-state/v1/connect/transfer/from/${DEVICE_ID}/to/${to}`, {
      method: 'POST',
      body: JSON.stringify({ transfer_options: { restore_paused: 'resume' } })
    })
    return true as const
  })

/** Sets the playing device's volume, 0-100. */
export const volume = (percent: number): Promise<ConnectResult<true>> =>
  op(async () => {
    const c = await cluster()
    await call(`/connect-state/v1/connect/volume/from/${DEVICE_ID}/to/${c.active_device_id}`, {
      method: 'PUT',
      // Connect volume runs 0-65535.
      body: JSON.stringify({ volume: Math.round(percent * 655.35) })
    })
    return true as const
  })

const isTrack = (t: QueueItem): boolean => /^spotify:(track|episode):/.test(t.uri)

const find = (c: Cluster, uid: string): QueueItem => {
  const item = c.player_state.next_tracks.find((t) => t.uid === uid)
  if (!item) throw new Error('That track is no longer in the queue.')
  return item
}

/** An entry in the upcoming list: its position there and its uid, checked against fresh state. */
export type QueueRef = { index: number; uid: string }

/**
 * Upcoming tracks in play order. With repeat on, Spotify lists the same entries again under the
 * same uids, so `index` (into the full list) is what tells two of them apart.
 */
export const queue = (): Promise<ConnectResult<(QueueRef & { uri: string })[]>> =>
  op(async () =>
    (await cluster()).player_state.next_tracks
      .map(({ uri, uid }, index) => ({ uri, uid, index }))
      .filter(isTrack)
  )

/**
 * Moves an entry to just after `after`, or to the front when null. A repeated entry isn't a slot
 * of its own (Spotify replays the earlier one), so dragging it queues a copy of the song there.
 */
export const move = (from: QueueRef, after: QueueRef | null): Promise<ConnectResult<true>> =>
  op(async () => {
    const c = await cluster()
    const list = c.player_state.next_tracks
    const at = (r: QueueRef): QueueItem => {
      if (list[r.index]?.uid !== r.uid) throw new Error('The queue changed; try again.')
      return list[r.index]
    }
    const item = at(from)
    if (after) at(after)
    const repeat = list.findIndex((t) => t.uid === from.uid) < from.index
    const next = [...list]
    let to = after ? after.index + 1 : 0
    if (!repeat) {
      next.splice(from.index, 1)
      if (from.index < to) to--
    }
    next.splice(
      to,
      0,
      repeat
        ? {
            uri: item.uri,
            uid: `q${randomBytes(8).toString('hex')}`,
            provider: 'queue',
            metadata: { is_queued: 'true' }
          }
        : item
    )
    await send(c, {
      endpoint: 'set_queue',
      next_tracks: next,
      prev_tracks: c.player_state.prev_tracks,
      queue_revision: c.player_state.queue_revision
    })
    return true as const
  })

/**
 * Cover Flow's batched skip, `n` tracks forward or back to `uri`, as one ordered set of commands.
 * One "next" per track through the Web API can arrive out of step and land on the wrong track.
 */
export const skipBy = (n: number, uri: string): Promise<ConnectResult<true>> =>
  op(async () => {
    const c = await cluster()
    if (n > 0) {
      // The player skips forward to the first queued copy of `uri`, so that must be the nth.
      const next = c.player_state.next_tracks.filter(isTrack)
      if (next.findIndex((t) => t.uri === uri) !== n - 1)
        throw new Error('The queue changed; try again.')
      await send(c, { endpoint: 'skip_next', track: { uri, uid: next[n - 1].uid } })
    } else {
      if (c.player_state.prev_tracks.filter(isTrack).at(n)?.uri !== uri)
        throw new Error('The queue changed; try again.')
      // "Previous" mid-song restarts it; from the top it steps back a track.
      await send(c, { endpoint: 'seek_to', value: 0, position: 0 })
      for (let i = 0; i < -n; i++) await send(c, { endpoint: 'skip_prev' })
    }
    return true as const
  })

/** Jumps playback straight to a track further down the queue. */
export const skipTo = (uid: string): Promise<ConnectResult<true>> =>
  op(async () => {
    const c = await cluster()
    const { uri } = find(c, uid)
    await send(c, { endpoint: 'skip_next', track: { uri, uid } })
    return true as const
  })

/** A Jam (what Spotify's API still calls a social session), as the UI shows it. */
export type Jam = {
  id: string
  /** The host, who can end it for everyone; guests can only leave. */
  owner: boolean
  link: string
  members: { id: string; name: string; image?: string }[]
}

type Session = {
  session_id: string
  join_session_token: string
  is_session_owner?: boolean
  session_members?: { id: string; username?: string; display_name?: string; image_url?: string }[]
}

const toJam = (s: Session | null): Jam | null =>
  s && {
    id: s.session_id,
    owner: !!s.is_session_owner,
    link: `https://open.spotify.com/socialsession/${s.join_session_token}`,
    members: (s.session_members ?? []).map((m) => ({
      id: m.id,
      name: m.display_name || m.username || 'Someone',
      image: m.image_url || undefined
    }))
  }

// librespot's device; a Jam joined here plays on it.
const player = (c: Cluster): string => {
  const id = Object.entries(c.devices ?? {}).find(([, d]) => d.name === 'MusicThing')?.[0]
  if (!id) throw new Error("MusicThing's player isn't connected yet; try again in a moment.")
  return id
}

// Social-connect answers "not in a Jam" with 404 (or 410 for one that just ended). Like the
// desktop app, requests carry the dealer connection, which session updates are pushed to.
async function session(path: string, init: RequestInit = {}): Promise<Session | null> {
  try {
    const res = await call(`/social-connect${path}`, {
      ...init,
      headers: { 'spotify-connection-id': (await connection) ?? '' }
    })
    return res.status === 204 ? null : ((await res.json()) as Session)
  } catch (err) {
    if (err instanceof Error && /answered (404|410)$/.test(err.message)) return null
    throw err
  }
}

// Invite links: open.spotify.com/socialsession/<token>, spotify:socialsession:<token>, or a
// spotify.link short link that redirects to the first.
async function joinToken(link: string): Promise<string> {
  const token = (s: string): string | undefined => s.match(/socialsession[/:]([\w-]+)/)?.[1]
  let found = token(link)
  if (!found && /^https:\/\/spotify\.link\//.test(link.trim())) {
    const res = await fetch(link.trim())
    found = token(res.url) ?? token(await res.text())
  }
  if (!found) throw new Error("That isn't a Jam invite link.")
  return found
}

/**
 * The user's Jam, after an optional action. `start` makes one around what's playing (Premium
 * only), `join` takes an invite link and plays it here, `leave` ends it for everyone when hosting.
 * Endpoints are the official desktop app's, as captured by others; the web player has none.
 */
export const jam = (
  action: 'current' | 'start' | 'join' | 'leave',
  link?: string
): Promise<ConnectResult<Jam | null>> =>
  op(async () => {
    const c = await cluster()
    const here = (): string => `local_device_id=${player(c)}`
    if (action === 'start') return toJam(await session('/v2/sessions/current_or_new?activate=true'))
    if (action === 'join') {
      const token = await joinToken(link ?? '')
      return toJam(
        await session(`/v2/sessions/join/${token}?${here()}&playback_control=listen_and_control`, {
          method: 'POST'
        })
      )
    }
    const current = await session('/v2/sessions/current')
    if (action === 'leave' && current) {
      if (current.is_session_owner)
        await session(`/v3/sessions/${encodeURIComponent(current.session_id)}`, {
          method: 'DELETE'
        })
      else await session(`/v2/sessions/leave?${here()}`, { method: 'POST' })
      return null
    }
    return toJam(current)
  })

/** Calls `cb` whenever the Jam changes (someone joins, leaves, or it ends). */
export const watchJam = (cb: () => void): void => {
  jamWatcher = cb
}
