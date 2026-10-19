import { BrowserWindow, session } from 'electron'

/**
 * Playlist contents through open.spotify.com's private GraphQL API, for playlists the Web API
 * refuses (Feb 2026: only owned or collaborative ones are readable).
 *
 * A hidden window loads the web player and Spotify's own code does the token dance (TOTP-signed
 * /api/token, clienttoken). We copy the headers and persisted-query hash from its first real
 * fetchPlaylist request, then make the same request ourselves, so nothing here hard-codes
 * secrets or hashes that Spotify rotates. Anonymous by default (public playlists); after
 * `login()` the session is the user's, so private playlists they can see work too.
 *
 * Against Spotify's developer terms, and can break whenever the web player changes.
 */

const PARTITION = 'persist:webplayer'
const PATHFINDER = 'https://api-partner.spotify.com/pathfinder/v2/query'
const CAPTURE_TIMEOUT_MS = 25_000
// Headers the session or the network stack sets itself.
const SKIP_HEADERS = new Set(['host', 'content-length', 'connection', 'cookie', 'accept-encoding'])

type Query = { variables: Record<string, unknown>; hash: string }
type Captured = { headers: Record<string, string>; query: Query }

let captured: Captured | null = null
let capturing: Promise<Captured> | null = null
// Receives the next captured request while a capture window is open.
let hookCallback: ((c: Captured) => void) | null = null
// Token headers from the web player's latest call to Spotify's own APIs, for connect.ts.
const AUTH_HEADERS = ['authorization', 'client-token', 'spotify-app-version', 'app-platform']
let auth: Record<string, string> | null = null
let authWaiter: (() => void) | null = null

export type WebTrack = {
  id: string | null
  uri: string
  name: string
  duration_ms: number
  artists: { name: string }[]
  album: { uri: string; name: string; images: { url: string; width: number | null }[] }
}
export type WebPage =
  | { items: { item: WebTrack | null }[]; total: number; next: number | null }
  | { error: 'hidden' | 'unavailable' }

// Spotify serves Electron's user agent a static "Open App" page instead of the web player, so
// this session presents itself as the Chrome that Electron is built on.
const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
const ses = (): Electron.Session => {
  const s = session.fromPartition(PARTITION)
  s.setUserAgent(USER_AGENT)
  // The web player hands spotify: links to the desktop app, which Electron would launch.
  s.setPermissionRequestHandler((_, permission, cb) => cb(permission !== 'openExternal'))
  return s
}

let hooked = false
function hook(): void {
  if (hooked) return
  hooked = true
  // Body and headers arrive in separate callbacks; pair them by request id.
  const queries = new Map<number, Query>()
  ses().webRequest.onBeforeRequest({ urls: [`${PATHFINDER}*`] }, (d, cb) => {
    try {
      const body = JSON.parse(d.uploadData?.[0]?.bytes?.toString() ?? '')
      if (body.operationName === 'fetchPlaylist')
        queries.set(d.id, {
          variables: body.variables,
          hash: body.extensions.persistedQuery.sha256Hash
        })
    } catch {
      // Not a JSON GraphQL call; nothing to learn from it.
    }
    cb({})
  })
  // One listener per session, so it also collects the token headers from any Spotify API call.
  ses().webRequest.onBeforeSendHeaders({ urls: ['https://*.spotify.com/*'] }, (d, cb) => {
    const lower = Object.fromEntries(
      Object.entries(d.requestHeaders).map(([k, v]) => [k.toLowerCase(), v])
    )
    if (lower.authorization && lower['client-token']) {
      auth = Object.fromEntries(AUTH_HEADERS.filter((k) => lower[k]).map((k) => [k, lower[k]]))
      authWaiter?.()
    }
    const query = queries.get(d.id)
    queries.delete(d.id)
    if (query) {
      const headers = Object.fromEntries(
        Object.entries(d.requestHeaders).filter(([k]) => !SKIP_HEADERS.has(k.toLowerCase()))
      )
      hookCallback?.({ headers, query })
    }
    cb({ requestHeaders: d.requestHeaders })
  })
}

function hiddenPlayer(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    // Desktop size: a small window gets the mobile web player, which uses other queries.
    width: 1280,
    height: 900,
    webPreferences: { partition: PARTITION, sandbox: true, backgroundThrottling: false }
  })
  win.webContents.setAudioMuted(true)
  return win
}

/** The web player isn't signed in to the user's account. */
export class SignedOut extends Error {}

let authing: Promise<Record<string, string>> | null = null
/**
 * The signed-in web player's token headers. `fresh` drops the cached ones (after a 401) and loads
 * the web player again so its own code fetches new ones.
 */
export async function webAuth(fresh = false): Promise<Record<string, string>> {
  // Checked every time: headers cached from an anonymous playlist capture aren't the user's.
  if (!(await ses().cookies.get({ name: 'sp_dc' })).length) throw new SignedOut()
  if (fresh) auth = null
  if (auth) return auth
  authing ??= (async () => {
    try {
      hook()
      const win = hiddenPlayer()
      try {
        await new Promise<void>((resolve, reject) => {
          authWaiter = resolve
          setTimeout(() => reject(new Error('Spotify web player did not load')), CAPTURE_TIMEOUT_MS)
          win.loadURL('https://open.spotify.com/')
        })
      } finally {
        authWaiter = null
        win.destroy()
      }
      return auth!
    } finally {
      authing = null
    }
  })()
  return authing
}

// Opens the playlist in a hidden, muted web player just long enough to see one fetchPlaylist call.
function capture(playlistId: string): Promise<Captured> {
  capturing ??= new Promise<Captured>((resolve, reject) => {
    const win = hiddenPlayer()
    const done = (err: Error | null, c?: Captured): void => {
      clearTimeout(timer)
      hookCallback = null
      if (!win.isDestroyed()) win.destroy()
      capturing = null
      if (c) resolve((captured = c))
      else reject(err)
    }
    const timer = setTimeout(
      () => done(new Error('Spotify web player did not load the playlist')),
      CAPTURE_TIMEOUT_MS
    )
    hookCallback = (c) => done(null, c)
    hook()
    win.loadURL(`https://open.spotify.com/playlist/${playlistId}`)
  })
  return capturing
}

/** One page of a playlist, newest web-player shapes mapped onto the Web API's track shape. */
export async function playlistPage(
  playlistId: string,
  offset: number,
  limit = 100
): Promise<WebPage> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { headers, query } = captured ?? (await capture(playlistId))
    const res = await ses().fetch(PATHFINDER, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({
        variables: { ...query.variables, uri: `spotify:playlist:${playlistId}`, offset, limit },
        operationName: 'fetchPlaylist',
        extensions: { persistedQuery: { version: 1, sha256Hash: query.hash } }
      })
    })
    // Expired token or a rotated query hash: capture fresh ones and retry once.
    if (!res.ok) {
      captured = null
      continue
    }
    const playlist = (await res.json())?.data?.playlistV2
    if (playlist?.__typename !== 'Playlist') return { error: 'hidden' }
    const content = playlist.content
    const items = (content.items as RawItem[]).map((i) => ({ item: toTrack(i.itemV2?.data) }))
    const end = offset + items.length
    return {
      items,
      total: content.totalCount,
      next: items.length && end < content.totalCount ? end : null
    }
  }
  return { error: 'unavailable' }
}

type RawTrack = {
  __typename: string
  uri: string
  name: string
  trackDuration?: { totalMilliseconds: number }
  artists?: { items: { profile: { name: string } }[] }
  albumOfTrack?: {
    uri: string
    name: string
    coverArt?: { sources: { url: string; width: number | null }[] }
  }
}
type RawItem = { itemV2?: { data?: RawTrack } }

function toTrack(t: RawTrack | undefined): WebTrack | null {
  if (t?.__typename !== 'Track') return null // episodes, unavailable and local items
  return {
    id: t.uri.split(':')[2] ?? null,
    uri: t.uri,
    name: t.name,
    duration_ms: t.trackDuration?.totalMilliseconds ?? 0,
    artists: t.artists?.items.map((a) => ({ name: a.profile.name })) ?? [],
    album: {
      uri: t.albumOfTrack?.uri ?? '',
      name: t.albumOfTrack?.name ?? '',
      // Largest first, matching the Web API's order.
      images: [...(t.albumOfTrack?.coverArt?.sources ?? [])].sort(
        (a, b) => (b.width ?? 0) - (a.width ?? 0)
      )
    }
  }
}

/**
 * Signs the web-player session in as the user so private playlists they can see work too.
 * Resolves true once Spotify sends the window back to the web player, false if it's closed.
 */
export function login(parent?: BrowserWindow): Promise<boolean> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      parent,
      width: 480,
      height: 720,
      title: 'Sign in to Spotify',
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, sandbox: true }
    })
    let ok = false
    win.webContents.on('did-navigate', (_, url) => {
      if (!url.startsWith('https://open.spotify.com')) return
      ok = true
      captured = auth = null // the next capture picks up the signed-in token
      win.close()
    })
    win.on('closed', () => resolve(ok))
    win.loadURL(
      'https://accounts.spotify.com/login?continue=' +
        encodeURIComponent('https://open.spotify.com/')
    )
  })
}
