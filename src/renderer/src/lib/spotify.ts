// Web API client. Requests are answered by the main process (main/webapi.ts), in the Web API's
// shapes, from Spotify's web player and Spotify Connect.
export class Unauthorized extends Error {}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

/** `path` is relative to /v1, or an absolute `next` URL from a paging object. */
export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T | null> {
  const body = typeof init?.body === 'string' ? init.body : undefined
  const res = await window.api.spotify(init?.method ?? 'GET', path, body)
  if (res.status === 401) throw new Unauthorized()
  if (res.status >= 400) {
    const message = (res.body as { error?: { message?: string } } | null)?.error?.message
    throw new ApiError(res.status, message ?? `Spotify returned ${res.status}`)
  }
  return res.body as T | null
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
