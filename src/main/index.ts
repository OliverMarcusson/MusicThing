import { app, shell, BrowserWindow, ipcMain, Menu, nativeTheme, Tray } from 'electron'
import { join } from 'path'
import { hostname } from 'os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import iconDark from '../../resources/icon-dark.png?asset'
import iconLight from '../../resources/icon-light.png?asset'
import { getToken, login, logout } from './auth'
import { hideSpotify, showSpotify, spotifyHidden, watchSpotify } from './spotify-window'
import { login as webLogin, playlistPage } from './webplayer'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

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
  // Rebuilt on open so the Spotify toggle label stays current.
  tray.on('right-click', () =>
    tray?.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open', click: showWindow },
        spotifyHidden()
          ? { label: 'Show Spotify app', click: () => showSpotify() }
          : { label: 'Hide Spotify app', click: () => hideSpotify() },
        { type: 'separator' },
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
  ipcMain.handle('app:hostname', () => hostname())
  ipcMain.handle('web:playlist', (_, id: string, offset: number) => playlistPage(id, offset))
  ipcMain.handle('web:login', () => webLogin(mainWindow ?? undefined))

  createWindow()
  createTray()
  hideSpotify()
  watchSpotify()
})

// Give the Spotify window back (minimized) so it isn't stranded invisible after we exit.
app.on('before-quit', (e) => {
  if (quitting) return
  quitting = true
  e.preventDefault()
  showSpotify(true).finally(() => app.quit())
})
