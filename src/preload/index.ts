import { contextBridge, ipcRenderer } from 'electron'
import type { WebPage } from '../main/webplayer'
import type { Cluster, ConnectResult, QueueRef } from '../main/connect'

export type UpdateStatus = 'none' | 'downloading' | 'ready'

const api = {
  token: (): Promise<string | null> => ipcRenderer.invoke('auth:token'),
  /** Playlist pages via the web player, for playlists the Web API refuses. */
  webPlaylist: (id: string, offset: number): Promise<WebPage> =>
    ipcRenderer.invoke('web:playlist', id, offset),
  /** The app's one Spotify sign-in; resolves false if the window was closed. */
  webLogin: (): Promise<boolean> => ipcRenderer.invoke('web:login'),
  /** Queue editing over Spotify Connect; needs the user signed in. */
  connectQueue: (): Promise<ConnectResult<(QueueRef & { uri: string })[]>> =>
    ipcRenderer.invoke('connect:queue'),
  connectMove: (from: QueueRef, after: QueueRef | null): Promise<ConnectResult<true>> =>
    ipcRenderer.invoke('connect:move', from, after),
  connectSkipTo: (uid: string): Promise<ConnectResult<true>> =>
    ipcRenderer.invoke('connect:skipTo', uid),
  connectSkipBy: (n: number, uri: string): Promise<ConnectResult<true>> =>
    ipcRenderer.invoke('connect:skipBy', n, uri),
  /** Starts (or re-reads) the playback state pushed over Spotify Connect; see onCluster. */
  connectWatch: (): Promise<ConnectResult<true>> => ipcRenderer.invoke('connect:watch'),
  /** Calls back with every playback state push; returns the unsubscribe. */
  onCluster: (cb: (c: Cluster) => void): (() => void) => {
    const listener = (_: unknown, c: Cluster): void => cb(c)
    ipcRenderer.on('connect:cluster', listener)
    return () => ipcRenderer.removeListener('connect:cluster', listener)
  },
  updateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:status'),
  /** Calls back whenever the update status changes; returns the unsubscribe. */
  onUpdateStatus: (cb: (status: UpdateStatus) => void): (() => void) => {
    const listener = (_: unknown, status: UpdateStatus): void => cb(status)
    ipcRenderer.on('update:status', listener)
    return () => ipcRenderer.removeListener('update:status', listener)
  },
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke('update:check'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install')
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
