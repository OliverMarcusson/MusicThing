import { contextBridge, ipcRenderer } from 'electron'
import type { WebPage } from '../main/webplayer'
import type { ConnectResult } from '../main/connect'

const api = {
  token: (): Promise<string | null> => ipcRenderer.invoke('auth:token'),
  login: (): Promise<string> => ipcRenderer.invoke('auth:login'),
  logout: (): Promise<void> => ipcRenderer.invoke('auth:logout'),
  /** Playlist pages via the web player, for playlists the Web API refuses. */
  webPlaylist: (id: string, offset: number): Promise<WebPage> =>
    ipcRenderer.invoke('web:playlist', id, offset),
  webLogin: (): Promise<boolean> => ipcRenderer.invoke('web:login'),
  /** Queue editing over Spotify Connect; needs the web player signed in. */
  connectQueue: (): Promise<ConnectResult<{ uri: string; uid: string }[]>> =>
    ipcRenderer.invoke('connect:queue'),
  connectMove: (uid: string, after: string | null): Promise<ConnectResult<true>> =>
    ipcRenderer.invoke('connect:move', uid, after),
  connectSkipTo: (uid: string): Promise<ConnectResult<true>> =>
    ipcRenderer.invoke('connect:skipTo', uid)
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
