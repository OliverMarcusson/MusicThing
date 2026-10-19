// Thin Web API client. The access token comes from the main process.
export class Unauthorized extends Error {}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

// After a 429 every request waits out Spotify's Retry-After; hammering on only extends the limit.
let coolUntil = 0
const MAX_WAIT_MS = 30_000
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** `path` is relative to /v1, or an absolute `next` URL from a paging object. */
export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T | null> {
  const url = path.startsWith('https://') ? path : `https://api.spotify.com/v1${path}`
  let res: Response
  for (let attempt = 0; ; attempt++) {
    const wait = coolUntil - Date.now()
    if (wait > MAX_WAIT_MS) throw new ApiError(429, 'API rate limit exceeded')
    if (wait > 0) await sleep(wait)
    const token = await window.api.token()
    if (!token) throw new Unauthorized()
    res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init?.headers }
    })
    if (res.status !== 429 || attempt >= 2) break
    // The header may be missing or hidden by CORS; then guess a few seconds.
    const seconds = Number(res.headers.get('Retry-After')) || 5
    coolUntil = Math.max(coolUntil, Date.now() + seconds * 1000)
  }
  if (res.status === 401) throw new Unauthorized()
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
    throw new ApiError(res.status, body?.error?.message ?? `Spotify returned ${res.status}`)
  }
  // Player commands answer 200/204 with an empty or non-JSON body.
  const text = await res.text()
  try {
    return text ? (JSON.parse(text) as T) : null
  } catch {
    return null
  }
}

export type Image = { url: string; width: number | null }

export type Album = {
  id: string
  name: string
  uri: string
  images: Image[]
  artists: { name: string }[]
}

export type Track = {
  id: string | null
  uri: string
  name: string
  duration_ms: number
  artists: { name: string }[]
  album?: { id?: string; uri?: string; name: string; images: Image[] }
}

export type Playlist = {
  id: string
  name: string
  uri: string
  images: Image[] | null
  owner: { id: string; display_name: string | null }
  collaborative: boolean
}

export type Paging<T> = { items: T[]; next: string | null; total: number }

export type PlaybackState = {
  is_playing: boolean
  progress_ms: number | null
  shuffle_state: boolean
  repeat_state: 'off' | 'track' | 'context'
  item: Track | null
  device: { id: string | null; name: string; volume_percent: number | null }
}

let me: Promise<string | undefined> | null = null
/** Your Spotify user id, fetched once; a failed request is retried next call. */
export function myId(): Promise<string | undefined> {
  me ??= api<{ id: string }>('/me').then(
    (m) => m?.id,
    (e) => {
      me = null
      throw e
    }
  )
  return me
}

/** Follows `next` links until done, up to `max` items. For small lists like your playlists. */
export async function fetchAll<T>(path: string, max = 500): Promise<T[]> {
  const out: T[] = []
  let next: string | null = path
  while (next && out.length < max) {
    const page: Paging<T> | null = await api<Paging<T>>(next)
    out.push(...(page?.items ?? []))
    next = page?.next ?? null
  }
  return out
}

/** Smallest image at least `min` px wide, falling back to the largest. */
export function imageUrl(images: Image[] | null | undefined, min = 0): string | undefined {
  if (!images?.length) return undefined
  const fit = [...images].reverse().find((i) => (i.width ?? Infinity) >= min)
  return (fit ?? images[0]).url
}
