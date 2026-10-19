import { randomBytes } from 'crypto'
import { SignedOut, webAuth } from './webplayer'

/**
 * Queue editing through Spotify Connect's private API, the one the official apps use; the Web API
 * can only append to the queue. Commands need a sending device, so a hidden one that never plays
 * is registered on a dealer socket. Auth is the signed-in web player's (see webplayer.ts).
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
type Cluster = {
  active_device_id: string
  player_state: { queue_revision: string; next_tracks: QueueItem[]; prev_tracks: QueueItem[] }
}
export type ConnectResult<T> = { ok: T } | { error: 'signin' | 'failed'; message: string }

class Unauthorized extends Error {}

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
      const id = JSON.parse(String(e.data)).headers?.['Spotify-Connection-Id']
      if (id) resolve(id)
    }
    ws.onclose = () => {
      clearInterval(ping)
      connection = null
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
  return res.json()
}

async function send(c: Cluster, command: Record<string, unknown>): Promise<Response> {
  try {
    return await call(
      `/connect-state/v1/player/command/from/${DEVICE_ID}/to/${c.active_device_id}`,
      {
        method: 'POST',
        body: JSON.stringify({
          command: { ...command, logging_params: { command_id: randomBytes(16).toString('hex') } }
        })
      }
    )
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
