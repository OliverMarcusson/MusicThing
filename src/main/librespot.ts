import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { getToken } from './webplayer'

/**
 * The player: librespot, an open-source reimplementation of the official client's protocol,
 * registers this app as its own Spotify Connect device and plays the audio, so the official
 * app isn't needed. Build it with `bun run librespot` (needs cargo).
 *
 * The first run signs in with the web player's token (the app's one login, webplayer.ts); the
 * reusable credentials Spotify hands back are cached in userData/librespot. Should Spotify refuse
 * that token, it falls back to librespot's own browser sign-in.
 *
 * Can break whenever Spotify changes the protocol.
 */

// The Connect device name; player.ts targets the device by it.
const DEVICE_NAME = 'MusicThing'
const OAUTH_PORT = '5588'
const RESTART_MS = 5000

// Executables can't run from inside the asar; electron-builder unpacks resources/ next to it.
const bin = join(
  app.getAppPath(),
  'resources/librespot/bin',
  process.platform === 'win32' ? 'librespot.exe' : 'librespot'
).replace('app.asar', 'app.asar.unpacked')

let child: ChildProcess | null = null
let starting = false
let stopping = false
let tokenRefused = false

/** Starts the player; without cached credentials it waits for the web player to be signed in. */
export async function startPlayer(): Promise<void> {
  if (child || starting || stopping) return
  const dir = join(app.getPath('userData'), 'librespot')
  const credentials = join(dir, 'credentials.json')
  let token: string | null = null
  if (!tokenRefused && !existsSync(credentials)) {
    starting = true
    try {
      token = await getToken()
    } catch (err) {
      console.error('librespot sign-in token unavailable; retrying:', err)
      setTimeout(startPlayer, RESTART_MS)
      return
    } finally {
      starting = false
    }
    // Signed out: the web:login handler starts the player after sign-in.
    if (!token || child || stopping) return
  }
  child = spawn(
    bin,
    [
      ['--name', DEVICE_NAME],
      ['--device-type', 'computer'],
      ['--bitrate', '320'],
      ['--system-cache', dir],
      ['--cache', join(dir, 'audio')],
      ['--cache-size-limit', '1G'],
      ['--disable-discovery'],
      // Only used while no credentials are cached and Spotify refused the web player's token.
      token ? [] : ['--enable-oauth', '--oauth-port', OAUTH_PORT]
    ].flat(),
    // An env var rather than an argument keeps the token out of the process list.
    {
      windowsHide: true,
      env: token ? { ...process.env, LIBRESPOT_ACCESS_TOKEN: token } : undefined
    }
  )
  const log = (d: Buffer): boolean => process.stderr.write(`[librespot] ${d}`)
  child.stdout?.on('data', log)
  child.stderr?.on('data', log)
  child.on('error', (err) => console.error('librespot failed to start:', err))
  child.on('exit', (code) => {
    child = null
    if (token && !existsSync(credentials)) tokenRefused = true
    // ponytail: fixed-delay restart; back off if a broken login makes it loop.
    if (!stopping) {
      console.error(`librespot exited (${code}); restarting`)
      setTimeout(startPlayer, RESTART_MS)
    }
  })
}

export function stopPlayer(): void {
  stopping = true
  child?.kill()
}
