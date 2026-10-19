import { app, shell, BrowserWindow, ipcMain, Menu, nativeTheme, Tray } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import iconDark from '../../resources/icon-dark.png?asset'
import iconLight from '../../resources/icon-light.png?asset'
import { getToken, login, logout } from './auth'
import { startPlayer, stopPlayer } from './librespot'
import { login as webLogin, playlistPage } from './webplayer'
import {
  move as connectMove,
  queue as connectQueue,
  skipBy as connectSkipBy,
  skipTo as connectSkipTo
} from './connect'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
// Set once an update has downloaded; it installs on the next quit, or now via the tray.
let updateReady = false
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000

// Off-white lines on a dark taskbar, grey on a light one.
const icon = (): string => (nativeTheme.shouldUseDarkColors ? iconDark : iconLight)

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
        ...(updateReady
          ? [{ label: 'Restart to update', click: () => autoUpdater.quitAndInstall() }]
          : []),
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
  ipcMain.handle('auth:login', () => login())
  ipcMain.handle('auth:logout', () => logout())
  ipcMain.handle('web:playlist', (_, id: string, offset: number) => playlistPage(id, offset))
  ipcMain.handle('web:login', () => webLogin(mainWindow ?? undefined))
  ipcMain.handle('connect:queue', () => connectQueue())
  ipcMain.handle('connect:move', (_, uid: string, after: string | null) => connectMove(uid, after))
  ipcMain.handle('connect:skipTo', (_, uid: string) => connectSkipTo(uid))
  ipcMain.handle('connect:skipBy', (_, n: number, uri: string) => connectSkipBy(n, uri))

  createWindow()
  createTray()
  checkForUpdates()
  startPlayer()
})

// Installed builds poll the homelab feed (electron-builder.yml `publish`) and download in the
// background; a dev run has no feed to compare against.
function checkForUpdates(): void {
  if (!app.isPackaged) return
  autoUpdater.on('update-downloaded', () => (updateReady = true))
  // Offline or feed down: try again next round.
  const check = (): void => void autoUpdater.checkForUpdates().catch(() => {})
  check()
  setInterval(check, UPDATE_CHECK_MS)
}

app.on('before-quit', () => {
  quitting = true
  stopPlayer()
})
