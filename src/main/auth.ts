import { app, safeStorage, shell } from 'electron'
import { createHash, randomBytes } from 'crypto'
import { createServer } from 'http'
import { readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'

// Spotify PKCE flow. Tokens never leave the main process except the short-lived access token.
const CLIENT_ID = import.meta.env.MAIN_VITE_SPOTIFY_CLIENT_ID ?? ''
const REDIRECT_URI = 'http://127.0.0.1:8888/callback'
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-library-read',
  'playlist-read-private',
  'playlist-read-collaborative'
].join(' ')

const tokenFile = (): string => join(app.getPath('userData'), 'refresh-token')

let access: { token: string; expires: number } | null = null
let refreshing: Promise<string | null> | null = null
let loggingIn: Promise<string> | null = null

class TokenError extends Error {
  constructor(
    readonly status: number,
    body: string
  ) {
    super(`Spotify token request failed (${status}): ${body}`)
  }
}

async function requestToken(params: Record<string, string>): Promise<string> {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params })
  })
  if (!res.ok) throw new TokenError(res.status, await res.text())
  const json = (await res.json()) as {
    access_token: string
    expires_in: number
    refresh_token?: string
  }
  access = { token: json.access_token, expires: Date.now() + (json.expires_in - 60) * 1000 }
  // Spotify rotates refresh tokens, so persist each new one.
  if (json.refresh_token)
    await writeFile(tokenFile(), safeStorage.encryptString(json.refresh_token))
  return access.token
}

async function refresh(): Promise<string | null> {
  let refreshToken: string
  try {
    refreshToken = safeStorage.decryptString(await readFile(tokenFile()))
  } catch {
    return null
  }
  try {
    return await requestToken({ grant_type: 'refresh_token', refresh_token: refreshToken })
  } catch (err) {
    // Only a rejected grant means the stored token is dead; network errors keep it.
    if (err instanceof TokenError && err.status === 400) await logout()
    throw err
  }
}

export async function getToken(): Promise<string | null> {
  if (access && Date.now() < access.expires) return access.token
  // Concurrent callers share one refresh so a rotated token isn't used twice.
  refreshing ??= refresh().finally(() => (refreshing = null))
  return refreshing
}

export function login(): Promise<string> {
  if (!CLIENT_ID) return Promise.reject(new Error('MAIN_VITE_SPOTIFY_CLIENT_ID is not set in .env'))
  loggingIn ??= new Promise<string>((resolve, reject) => {
    const verifier = randomBytes(64).toString('base64url')
    const state = randomBytes(16).toString('hex')
    const timeout = setTimeout(() => finish(new Error('Login timed out')), 5 * 60_000)

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URI)
      if (url.pathname !== '/callback') return void res.writeHead(404).end()
      const code = url.searchParams.get('code')
      const ok = code !== null && url.searchParams.get('state') === state
      res
        .writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end(ok ? 'Logged in. You can close this tab.' : 'Login failed. You can close this tab.')
      if (!ok) return finish(new Error(url.searchParams.get('error') ?? 'Login state mismatch'))
      requestToken({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier
      }).then((token) => finish(null, token), finish)
    })

    function finish(err: Error | null, token?: string): void {
      clearTimeout(timeout)
      server.close()
      loggingIn = null
      if (err) reject(err)
      else resolve(token!)
    }

    server.on('error', finish)
    server.listen(8888, '127.0.0.1', () => {
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        scope: SCOPES,
        state,
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url')
      })
      shell.openExternal(`https://accounts.spotify.com/authorize?${params}`)
    })
  })
  return loggingIn
}

export async function logout(): Promise<void> {
  access = null
  await rm(tokenFile(), { force: true })
}
