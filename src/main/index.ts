import {
  app,
  dialog,
  shell,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  session,
  Tray
} from 'electron'
import { createHash } from 'crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import { startPlayer, stopPlayer } from './librespot'
import { getToken, login } from './webplayer'
import { webApi } from './webapi'
import {
  jam as connectJam,
  move as connectMove,
  pauseForRestart,
  resumeAfterRestart,
  transfer as connectTransfer,
  watchJam,
  queue as connectQueue,
  skipBy as connectSkipBy,
  skipTo as connectSkipTo,
  watch as connectWatch,
  type QueueRef
} from './connect'
import type { UpdateStatus } from '../preload'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
// A downloaded update applies on the next start, or now via the tray or the window's button.
let update: UpdateStatus = 'none'
const UPDATE_CHECK_MS = 5 * 60 * 1000
// electron-builder.yml `publish`; scripts/release.mjs uploads to it.
const FEED = 'https://musicthing.marcusson.dev/'
// The running code's version. app.getVersion() is the installed copy's, which boot.ts may have
// replaced with newer code.
const { version, librespot: player } = JSON.parse(
  readFileSync(join(__dirname, '../../package.json'), 'utf8')
)
// The player build that code needs ("librespot" in package.json). librespot runs from the installed
// copy's unpacked resources, which only the installer replaces, so newer code that needs a newer
// player than the installed copy has gets the installer.
const installedPlayer = (): string | undefined => {
  try {
    return JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')).librespot
  } catch {
    return undefined
  }
}
// New app code is picked up by boot.ts on any start; an installer update needs the installer run.
let install = (): void => {
  app.relaunch()
  app.quit()
}

// Restarting (to update, or from the tray) picks playback up where it was: playback here is paused
// first and a marker left, and the next start, finding a recent one, plays on from there. Without
// one a start stays quiet. The installer can take a while, hence the generous window.
const resumeMarker = (): string => join(app.getPath('userData'), 'resume-playback')
const RESUME_WITHIN_MS = 5 * 60_000
// A start that resumes playback, or that an invite link caused, isn't fresh; the settings page's
// startup playlist only plays on a fresh one, and only once (not on every window reload).
let freshStart = true
async function restart(then: () => void): Promise<void> {
  // A slow or failed pause mustn't hold the restart up.
  const paused = await Promise.race([
    pauseForRestart(),
    new Promise<boolean>((done) => setTimeout(done, 3000, false))
  ])
  if (paused) writeFileSync(resumeMarker(), '')
  then()
}

// Off-white lines on a dark taskbar, grey on a light one. From the installed copy: code that
// boot.ts loads from userData has no unpacked resources/ beside it.
const icon = (): string =>
  join(
    app.getAppPath(),
    nativeTheme.shouldUseDarkColors ? 'resources/icon-dark.png' : 'resources/icon-light.png'
  )

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0b0c0e',
    title: 'MusicThing',
    // Hide the native title bar but keep Windows' caption buttons, recoloured to match the app.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0c0e', symbolColor: '#a3a4a8', height: 36 },
    icon: icon(),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Closing the window sends the app to the tray; Quit lives in the tray menu.
  mainWindow.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    mainWindow?.hide()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function showWindow(): void {
  mainWindow?.show()
  mainWindow?.focus()
}

function createTray(): void {
  tray = new Tray(icon())
  nativeTheme.on('updated', () => {
    tray?.setImage(icon())
    mainWindow?.setIcon(icon())
  })
  tray.setToolTip('MusicThing')
  tray.on('click', showWindow)
  // Rebuilt on open so the update entry appears once one is ready.
  tray.on('right-click', () =>
    tray?.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open', click: showWindow },
        { type: 'separator' },
        // With an update downloaded, restarting applies it.
        update === 'ready'
          ? { label: 'Restart to update', click: () => restart(() => install()) }
          : {
              label: 'Restart',
              click: () => {
                // electron-vite's dev server exits along with Electron, so a relaunched dev app
                // would wait on nothing; there, reload the window (main restarts on save anyway).
                if (is.dev) return mainWindow?.webContents.reloadIgnoringCache()
                restart(() => {
                  app.relaunch()
                  app.quit()
                })
              }
            },
        { label: 'Quit', click: () => app.quit() }
      ])
    )
  )
}

// Jam invites (spotify.link → open.spotify.com/socialsession/<token>) hand off to whatever opens
// spotify: links, normally the official app. MusicThing claims those links and joins the Jam
// itself, playing it here. Other spotify: links just bring the window up.
const LINK = /^spotify:/i
if (is.dev) app.setAsDefaultProtocolClient('spotify', process.execPath, [resolve(process.argv[1])])
else app.setAsDefaultProtocolClient('spotify')

async function openLink(url: string): Promise<void> {
  freshStart = false
  showWindow()
  if (!/socialsession/i.test(url)) return
  // Opened by the link, the app has to wait for its player before it can join with it.
  for (let tries = 0; ; tries++) {
    const r = await connectJam('join', url)
    if ('ok' in r) return void mainWindow?.webContents.send('connect:jamChanged', r.ok)
    if (!/isn't connected yet/.test(r.message) || tries >= 20) {
      dialog.showMessageBox({ type: 'error', message: "Couldn't join the Jam", detail: r.message })
      return
    }
    await new Promise((done) => setTimeout(done, 3000))
  }
}

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', (_, argv) => {
  const url = argv.find((a) => LINK.test(a))
  if (url) openLink(url)
  else showWindow()
})
// macOS hands links over as an event instead.
app.on('open-url', (e, url) => {
  e.preventDefault()
  app.whenReady().then(() => openLink(url))
})

app.whenReady().then(() => {
  electronApp.setAppUserModelId('dev.marcusson.musicthing')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('auth:token', () => getToken())
  ipcMain.handle('spotify:request', (_, method: string, path: string, body?: string) =>
    webApi(method, path, body)
  )
  // The player waits for the first sign-in when it has no cached credentials.
  ipcMain.handle('web:login', async () => {
    const ok = await login(mainWindow ?? undefined)
    if (ok) startPlayer()
    return ok
  })
  ipcMain.handle('connect:queue', () => connectQueue())
  ipcMain.handle('connect:move', (_, from: QueueRef, after: QueueRef | null) =>
    connectMove(from, after)
  )
  ipcMain.handle('connect:skipTo', (_, uid: string) => connectSkipTo(uid))
  ipcMain.handle('connect:skipBy', (_, n: number, uri: string) => connectSkipBy(n, uri))
  ipcMain.handle('connect:transfer', (_, to: string) => connectTransfer(to))
  ipcMain.handle('connect:jam', (_, action: Parameters<typeof connectJam>[0], link?: string) =>
    connectJam(action, link)
  )
  watchJam((jam) => mainWindow?.webContents.send('connect:jamChanged', jam))
  ipcMain.handle('connect:watch', () =>
    connectWatch((c) => mainWindow?.webContents.send('connect:cluster', c))
  )
  ipcMain.handle('app:freshStart', () => {
    const fresh = freshStart
    freshStart = false
    return fresh
  })
  ipcMain.handle('update:status', () => update)
  ipcMain.handle('update:check', () => checkNow())
  ipcMain.handle('update:install', () => update === 'ready' && restart(() => install()))

  try {
    if (Date.now() - statSync(resumeMarker()).mtimeMs < RESUME_WITHIN_MS) {
      resumeAfterRestart()
      freshStart = false
    }
    rmSync(resumeMarker())
  } catch {
    // No marker: an ordinary start.
  }
  createWindow()
  createTray()
  const url = process.argv.find((a) => LINK.test(a))
  if (url) openLink(url)
  checkForUpdates()
  startPlayer()
})

const setUpdate = (status: UpdateStatus): void => {
  update = status
  mainWindow?.webContents.send('update:status', status)
}

// Installed builds poll the homelab feed and download in the background; a dev run has no feed to
// compare against. Ctrl+U in the window checks right away.
function checkForUpdates(): void {
  if (!app.isPackaged) return
  autoUpdater.on('update-available', () => setUpdate('downloading'))
  autoUpdater.on('update-downloaded', () => {
    // Silent, and the updated app opens again by itself.
    install = () => autoUpdater.quitAndInstall(true, true)
    setUpdate('ready')
  })
  // A failed download is offered again by the next check.
  autoUpdater.on('error', () => update === 'downloading' && setUpdate('none'))
  checkNow()
  setInterval(checkNow, UPDATE_CHECK_MS)
}

// The feed's app.json describes the latest app code. Built for this Electron, it's downloaded for
// boot.ts to run on the next start; otherwise the full installer is needed, through electron-updater.
// Offline or feed down: try again next round. Once one is downloaded there's nothing to look for.
async function checkNow(): Promise<void> {
  if (!app.isPackaged || update !== 'none') return
  try {
    if (player !== installedPlayer()) {
      await autoUpdater.checkForUpdates()
      return
    }
    const latest: { version: string; electron: string; file: string; sha512: string } = await (
      await net.fetch(`${FEED}app.json`, { cache: 'no-store' })
    ).json()
    if (latest.version.localeCompare(version, undefined, { numeric: true }) <= 0) return
    if (latest.electron !== process.versions.electron) {
      await autoUpdater.checkForUpdates()
      return
    }
    setUpdate('downloading')
    const res = await net.fetch(FEED + latest.file)
    if (!res.ok) throw new Error(`${latest.file} answered ${res.status}`)
    const data = Buffer.from(await res.arrayBuffer())
    if (createHash('sha512').update(data).digest('base64') !== latest.sha512)
      throw new Error(`${latest.file} doesn't match its checksum`)
    const dir = join(app.getPath('userData'), 'update')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'next.tmp'), data)
    // Beside it, so boot.ts can tell its version without opening it (see there).
    writeFileSync(join(dir, 'next.version'), latest.version)
    // Electron reads .asar paths as folders; this one is a plain file until boot.ts loads it.
    process.noAsar = true
    try {
      renameSync(join(dir, 'next.tmp'), join(dir, 'next.asar'))
    } finally {
      process.noAsar = false
    }
    setUpdate('ready')
  } catch {
    if ((update as UpdateStatus) === 'downloading') setUpdate('none')
  }
}

app.on('before-quit', () => {
  quitting = true
  stopPlayer()
  // localStorage (sidebar folds, pins, hidden playlists) reaches disk lazily; a change made just
  // before quitting would otherwise be lost.
  session.defaultSession.flushStorageData()
})
