import { app, shell, BrowserWindow, ipcMain, Menu, nativeTheme, net, session, Tray } from 'electron'
import { createHash } from 'crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import { startPlayer, stopPlayer } from './librespot'
import { getToken, login } from './webplayer'
import { webApi } from './webapi'
import {
  jam as connectJam,
  move as connectMove,
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
const version: string = JSON.parse(
  readFileSync(join(__dirname, '../../package.json'), 'utf8')
).version
// New app code is picked up by boot.ts on any start; an installer update needs the installer run.
let install = (): void => {
  app.relaunch()
  app.quit()
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
          ? { label: 'Restart to update', click: () => install() }
          : {
              label: 'Restart',
              click: () => {
                // electron-vite's dev server exits along with Electron, so a relaunched dev app
                // would wait on nothing; there, reload the window (main restarts on save anyway).
                if (is.dev) return mainWindow?.webContents.reloadIgnoringCache()
                app.relaunch()
                app.quit()
              }
            },
        { label: 'Quit', click: () => app.quit() }
      ])
    )
  )
}

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', showWindow)

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
  ipcMain.handle('update:status', () => update)
  ipcMain.handle('update:check', () => checkNow())
  ipcMain.handle('update:install', () => update === 'ready' && install())

  createWindow()
  createTray()
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
