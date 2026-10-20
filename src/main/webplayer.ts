import { BrowserWindow, session } from 'electron'

/**
 * open.spotify.com's private GraphQL API ("pathfinder"), which is how MusicThing reads Spotify:
 * the public Web API refuses the web player's token (webapi.ts translates its requests to this).
 *
 * A hidden window loads the web player and Spotify's own code does the token dance (TOTP-signed
 * /api/token, clienttoken); we copy the token headers from its requests. Queries are persisted:
 * each is sent as its operation name plus a hash, and the hashes are read from the web player's
 * own scripts, so nothing here hard-codes secrets or hashes that Spotify rotates.
 *
 * `login()` is the app's only Spotify sign-in; the same session also signs librespot in once
 * (librespot.ts) and drives Spotify Connect (connect.ts).
 *
 * Can break whenever the web player changes.
 */

const PARTITION = 'persist:webplayer'
const WEB_PLAYER = 'https://open.spotify.com/'
const PATHFINDER = 'https://api-partner.spotify.com/pathfinder/v2/query'
const LOAD_TIMEOUT_MS = 25_000
// How the web player's scripts declare a persisted query: name, kind, hash.
const PERSISTED = /"([A-Za-z0-9_]+)","(?:query|mutation)","([a-f0-9]{64})"/g

// Token headers from the web player's latest call to Spotify's own APIs.
const AUTH_HEADERS = ['authorization', 'client-token', 'spotify-app-version', 'app-platform']
// The web player's tokens last an hour; fetch new ones a little before that.
const AUTH_MAX_AGE_MS = 50 * 60_000
let auth: Record<string, string> | null = null
let authAt = 0
let authWaiter: (() => void) | null = null

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
  ses().webRequest.onBeforeSendHeaders({ urls: ['https://*.spotify.com/*'] }, (d, cb) => {
    const lower = Object.fromEntries(
      Object.entries(d.requestHeaders).map(([k, v]) => [k.toLowerCase(), v])
    )
    if (lower.authorization && lower['client-token']) {
      auth = Object.fromEntries(AUTH_HEADERS.filter((k) => lower[k]).map((k) => [k, lower[k]]))
      authAt = Date.now()
      authWaiter?.()
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
  // Checked every time: a signed-out session has no user to act as.
  if (!(await ses().cookies.get({ name: 'sp_dc' })).length) throw new SignedOut()
  if (fresh || Date.now() - authAt > AUTH_MAX_AGE_MS) auth = null
  if (auth) return auth
  authing ??= (async () => {
    try {
      hook()
      const win = hiddenPlayer()
      try {
        await new Promise<void>((resolve, reject) => {
          authWaiter = resolve
          setTimeout(() => reject(new Error('Spotify web player did not load')), LOAD_TIMEOUT_MS)
          win.loadURL(WEB_PLAYER)
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

/** The web player's access token, or null while it's signed out. */
export async function getToken(): Promise<string | null> {
  try {
    return (await webAuth()).authorization.replace(/^Bearer /, '')
  } catch (err) {
    if (err instanceof SignedOut) return null
    throw err
  }
}

let hashes: Promise<Map<string, string>> | null = null
/**
 * Persisted-query hashes by operation name, from the web player's main script. Search's queries
 * live in a chunk it loads on demand, whose file name comes from the main script's chunk map.
 */
function loadHashes(): Promise<Map<string, string>> {
  hashes ??= (async () => {
    const text = async (url: string): Promise<string> => {
      const res = await ses().fetch(url)
      if (!res.ok) throw new Error(`Spotify's web player answered ${res.status}`)
      return res.text()
    }
    const mainUrl = (await text(WEB_PLAYER)).match(
      /https:\/\/[^"]+\/web-player\/web-player\.[a-f0-9]+\.js/
    )?.[0]
    if (!mainUrl) throw new Error("Couldn't find the Spotify web player's scripts.")
    const main = await text(mainUrl)
    const found = new Map<string, string>()
    const collect = (js: string): void => {
      for (const [, name, hash] of js.matchAll(PERSISTED)) found.set(name, hash)
    }
    collect(main)
    const id = main.match(/(\d+):"xpui-routes-search"/)?.[1]
    // The map lists each chunk's script hash and its stylesheet hash; only the script answers.
    for (const [, hash] of id ? main.matchAll(new RegExp(`[,{]${id}:"([a-f0-9]{8})"`, 'g')) : []) {
      const res = await ses().fetch(
        mainUrl.replace(/web-player\.[a-f0-9]+\.js$/, `xpui-routes-search.${hash}.js`)
      )
      if (res.ok) {
        collect(await res.text())
        break
      }
    }
    return found
  })().catch((err) => {
    hashes = null
    throw err
  })
  return hashes
}

/**
 * Runs one of the web player's GraphQL operations as the signed-in user and returns its `data`.
 * An expired token or rotated hashes (the web player was updated) are fetched again, once.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function pathfinder<T = any>(
  operationName: string,
  variables: Record<string, unknown>
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const hash = (await loadHashes()).get(operationName)
    if (!hash) throw new Error(`Spotify's web player no longer has a ${operationName} query.`)
    const res = await ses().fetch(PATHFINDER, {
      method: 'POST',
      headers: {
        ...(await webAuth(attempt > 0)),
        'content-type': 'application/json;charset=UTF-8',
        accept: 'application/json'
      },
      body: JSON.stringify({
        variables,
        operationName,
        extensions: { persistedQuery: { version: 1, sha256Hash: hash } }
      })
    })
    const json = res.ok ? await res.json() : null
    if (json?.data) return json.data
    if (attempt > 0)
      throw new Error(json?.errors?.[0]?.message ?? `Spotify's web player answered ${res.status}`)
    hashes = null
  }
}

/**
 * Signs the web-player session in/**
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
      auth = null // the next request picks up the signed-in token
      win.close()
    })
    win.on('closed', () => resolve(ok))
    win.loadURL(
      'https://accounts.spotify.com/login?continue=' +
        encodeURIComponent('https://open.spotify.com/')
    )
  })
}
