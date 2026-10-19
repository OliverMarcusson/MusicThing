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
  skipTo as connectSkipTo,
  type QueueRef
} from './connect'
import type { UpdateStatus } from '../preload'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
// A downloaded update installs on the next quit, or now via the tray or the window's button.
let update: UpdateStatus = 'none'
const UPDATE_CHECK_MS = 5 * 60 * 1000

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
        ...(update === 'ready'
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
  ipcMain.handle('connect:move', (_, from: QueueRef, after: QueueRef | null) =>
    connectMove(from, after)
  )
  ipcMain.handle('connect:skipTo', (_, uid: string) => connectSkipTo(uid))
  ipcMain.handle('connect:skipBy', (_, n: number, uri: string) => connectSkipBy(n, uri))
  ipcMain.handle('update:status', () => update)
  ipcMain.handle('update:check', () => checkNow())
  ipcMain.handle('update:install', () => update === 'ready' && autoUpdater.quitAndInstall())

  createWindow()
  createTray()
  checkForUpdates()
  startPlayer()
})

// Installed builds poll the homelab feed (electron-builder.yml `publish`) and download in the
// background; a dev run has no feed to compare against. Ctrl+U in the window checks right away.
function checkForUpdates(): void {
  if (!app.isPackaged) return
  const set = (status: UpdateStatus): void => {
    update = status
    mainWindow?.webContents.send('update:status', status)
  }
  autoUpdater.on('update-available', () => set('downloading'))
  autoUpdater.on('update-downloaded', () => set('ready'))
  // A failed download is offered again by the next check.
  autoUpdater.on('error', () => update === 'downloading' && set('none'))
  checkNow()
  setInterval(checkNow, UPDATE_CHECK_MS)
}

// Offline or feed down: try again next round. Once one is downloaded there's nothing to look for.
function checkNow(): void {
  if (app.isPackaged && update === 'none') autoUpdater.checkForUpdates().catch(() => {})
}

app.on('before-quit', () => {
  quitting = true
  stopPlayer()
})
