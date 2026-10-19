import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'

/**
 * The player: librespot, an open-source reimplementation of the official client's protocol,
 * registers this app as its own Spotify Connect device and plays the audio, so the official
 * app isn't needed. Build it with `bun run librespot` (needs cargo).
 *
 * The first run opens a browser for a one-time Spotify sign-in (librespot's own, separate from
 * the Web API login); the reusable credentials it gets are cached in userData/librespot.
 *
 * Against Spotify's terms, and can break whenever Spotify changes the protocol.
 */

// The Connect device name; player.ts targets the device by it.
const DEVICE_NAME = 'MusicThing'
// Not 8888, which the Web API login listens on.
const OAUTH_PORT = '5588'
const RESTART_MS = 5000

// Executables can't run from inside the asar; electron-builder unpacks resources/ next to it.
const bin = join(
  app.getAppPath(),
  'resources/librespot/bin',
  process.platform === 'win32' ? 'librespot.exe' : 'librespot'
).replace('app.asar', 'app.asar.unpacked')

let child: ChildProcess | null = null
let stopping = false

export function startPlayer(): void {
  if (child) return
  const dir = join(app.getPath('userData'), 'librespot')
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
      // Only used while no credentials are cached.
      ['--enable-oauth'],
      ['--oauth-port', OAUTH_PORT]
    ].flat(),
    { windowsHide: true }
  )
  const log = (d: Buffer): boolean => process.stderr.write(`[librespot] ${d}`)
  child.stdout?.on('data', log)
  child.stderr?.on('data', log)
  child.on('error', (err) => console.error('librespot failed to start:', err))
  child.on('exit', (code) => {
    child = null
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
