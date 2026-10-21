import { pathfinder, SignedOut } from './webplayer'
import { command, state, transfer, volume, type ConnectResult } from './connect'

/**
 * Answers the Spotify Web API requests the renderer makes, in the Web API's own shapes, from the
 * web player's GraphQL queries (webplayer.ts) and Spotify Connect (connect.ts). The public Web API
 * itself refuses the web player's token, and a developer app of our own would cap how many
 * people can sign in.
 *
 * Only the requests the app makes are handled, with the parameters it sends.
 */

export type WebApiResponse = { status: number; body: unknown }

type Image = { url: string; width: number | null }
type Track = {
  id: string | null
  uri: string
  name: string
  duration_ms: number
  artists: { name: string }[]
  album?: { id: string | null; uri: string; name: string; images: Image[] }
}

// What the GraphQL API sends back is loosely shaped and changes without notice; read it defensively.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any

const BASE = 'https://api.spotify.com/v1'
const idOf = (uri: string): string | null => uri?.split(':')[2] ?? null

/** Largest first, like the Web API. */
const images = (sources: Raw[] | undefined): Image[] =>
  (sources ?? [])
    .map((s) => ({ url: s.url as string, width: (s.width as number | null) ?? null }))
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))

/** Null for what the Web API has no track for: episodes, local files, removed tracks. */
function toTrack(t: Raw, album?: Raw): Track | null {
  if (!t?.uri || (t.__typename && t.__typename !== 'Track')) return null
  const artists = t.artists?.items ?? [
    ...(t.firstArtist?.items ?? []),
    ...(t.otherArtists?.items ?? [])
  ]
  const a = album ?? t.albumOfTrack
  return {
    id: idOf(t.uri),
    uri: t.uri,
    name: t.name ?? '',
    duration_ms: t.duration?.totalMilliseconds ?? t.trackDuration?.totalMilliseconds ?? 0,
    artists: artists.map((x: Raw) => ({ name: x.profile?.name ?? '' })),
    album: a?.uri && {
      id: idOf(a.uri),
      uri: a.uri,
      name: a.name ?? '',
      images: images(a.coverArt?.sources)
    }
  }
}

const toAlbum = (a: Raw): Raw => ({
  id: idOf(a.uri),
  uri: a.uri,
  name: a.name ?? '',
  images: images(a.coverArt?.sources),
  artists: (a.artists?.items ?? []).map((x: Raw) => ({ name: x.profile?.name ?? '' }))
})

const toPlaylist = (p: Raw): Raw => ({
  id: idOf(p.uri),
  uri: p.uri,
  name: p.name ?? '',
  images: images(p.images?.items?.[0]?.sources),
  owner: { id: p.ownerV2?.data?.username ?? '', display_name: p.ownerV2?.data?.name ?? null },
  // The UI edits playlists you own or that are "collaborative"; this carries "you can edit it".
  collaborative: !!p.currentUserCapabilities?.canEditItems
})

/** A Web API paging object; `next` is a URL the renderer passes straight back here. */
function page<T>(route: string, offset: number, limit: number, items: T[], total: number): Raw {
  const end = offset + items.length
  return {
    items,
    total,
    next: items.length && end < total ? `${BASE}${route}?limit=${limit}&offset=${end}` : null
  }
}

let me: Promise<{ id: string; display_name: string | null }> | null = null
function profile(): Promise<{ id: string; display_name: string | null }> {
  me ??= pathfinder('profileAttributes', {}).then(
    (d) => ({ id: d.me.profile.username, display_name: d.me.profile.name ?? null }),
    (err) => {
      me = null
      throw err
    }
  )
  return me
}

async function library(
  filter: 'Playlists' | 'Albums',
  offset: number,
  limit: number
): Promise<Raw> {
  const d = await pathfinder('libraryV3', {
    filters: [filter],
    order: null,
    textFilter: '',
    features: [],
    limit,
    offset,
    flatten: true,
    expandedFolders: [],
    folderUri: null,
    includeFoldersWhenFlattening: false
  })
  const lib = d.me.libraryV3
  if (!Array.isArray(lib?.items)) throw new Error(`Spotify's library answered ${lib?.__typename}.`)
  return { items: lib.items.map((i: Raw) => i.item?.data).filter(Boolean), total: lib.totalCount }
}

async function playlistItems(id: string, offset: number, limit: number): Promise<Raw> {
  const d = await pathfinder('fetchPlaylist', {
    uri: `spotify:playlist:${id}`,
    offset,
    limit,
    enableWatchFeedEntrypoint: false
  })
  const p = d.playlistV2
  if (p?.__typename !== 'Playlist') throw new HttpError(404, "This playlist isn't available.")
  return p.content
}

// Track details by URI, shared by now playing and the queue, which ask for the same tracks.
const tracks = new Map<string, Promise<Track | null>>()
function trackByUri(uri: string): Promise<Track | null> {
  let t = tracks.get(uri)
  if (!t) {
    t = pathfinder('getTrack', { uri, includeVideoAssociationItems: false }).then(
      (d) => toTrack(d.trackUnion),
      (err) => {
        tracks.delete(uri)
        throw err
      }
    )
    tracks.set(uri, t)
  }
  return t
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

async function connect<T>(result: Promise<ConnectResult<T>>): Promise<T> {
  const r = await result
  if ('ok' in r) return r.ok
  throw r.error === 'signin' ? new SignedOut() : new Error(r.message)
}

/** Connect's play command; a lone track plays as its own context, like the Web API's `uris`. */
// `shuffle` is MusicThing's own: the Web API can only shuffle what's already playing, which would
// start on the context's first song.
function play(
  contextUri: string,
  trackUri: string | undefined,
  to?: string,
  shuffle = false
): Promise<true> {
  return connect(
    command(
      {
        endpoint: 'play',
        context: { uri: contextUri, url: `context://${contextUri}`, metadata: {} },
        play_origin: { feature_identifier: 'harmony' },
        options: {
          license: 'on-demand',
          skip_to: trackUri ? { track_uri: trackUri } : {},
          player_options_override: shuffle ? { shuffling_context: true } : {}
        }
      },
      to
    )
  )
}

async function route(
  method: string,
  path: string,
  q: URLSearchParams,
  body: Raw
): Promise<unknown> {
  const offset = Number(q.get('offset') ?? 0)
  const limit = Number(q.get('limit') ?? 50)
  const playlistId = path.match(/^\/playlists\/(\w+)\/items$/)?.[1]
  const albumId = path.match(/^\/albums\/(\w+)\/tracks$/)?.[1]
  const trackId = path.match(/^\/tracks\/(\w+)$/)?.[1]
  const to = q.get('device_id') ?? undefined

  if (method === 'GET') {
    if (path === '/me') return profile()
    if (path === '/me/playlists') {
      const { items, total } = await library('Playlists', offset, limit)
      return page(path, offset, limit, items.map(toPlaylist), total)
    }
    if (path === '/me/albums') {
      const { items, total } = await library('Albums', offset, limit)
      return page(
        path,
        offset,
        limit,
        items.map((a: Raw) => ({ album: toAlbum(a) })),
        total
      )
    }
    if (path === '/me/tracks') {
      const d = await pathfinder('fetchLibraryTracks', { offset, limit })
      const t = d.me.library.tracks
      const items = t.items.map((i: Raw) => ({
        track: toTrack({ uri: i.track?._uri, ...i.track?.data })
      }))
      return page(path, offset, limit, items, t.totalCount)
    }
    if (playlistId) {
      const content = await playlistItems(playlistId, offset, limit)
      const items = content.items.map((i: Raw) => ({ item: toTrack(i.itemV2?.data) }))
      return page(path, offset, limit, items, content.totalCount)
    }
    if (albumId) {
      const d = await pathfinder('getAlbum', {
        uri: `spotify:album:${albumId}`,
        locale: '',
        offset,
        limit
      })
      const a = d.albumUnion
      const items = a.tracksV2.items.map((i: Raw) => toTrack(i.track, a))
      return page(path, offset, limit, items, a.tracksV2.totalCount)
    }
    if (trackId) return trackByUri(`spotify:track:${trackId}`)
    if (path === '/search') {
      const d = await pathfinder('searchDesktop', {
        searchTerm: q.get('q') ?? '',
        offset: 0,
        limit,
        numberOfTopResults: 5,
        includeAudiobooks: false,
        includeArtistHasConcertsField: false,
        includePreReleases: false,
        includeAlbumPreReleases: false,
        includeAuthors: false,
        includeEpisodeContentRatingsV2: false,
        isPrefix: null,
        sectionFilters: ['GENERIC']
      })
      const s = d.searchV2
      const data = (list: Raw): Raw[] => (list?.items ?? []).map((i: Raw) => i.item?.data ?? i.data)
      return {
        tracks: {
          items: data(s.tracksV2)
            .map((t) => toTrack(t))
            .filter(Boolean)
        },
        albums: {
          items: data(s.albumsV2)
            .filter((a) => a?.__typename === 'Album')
            .map(toAlbum)
        },
        playlists: {
          items: data(s.playlists)
            .filter((p) => p?.__typename === 'Playlist')
            .map(toPlaylist)
        }
      }
    }
    if (path === '/me/player/devices') {
      const c = await connect(state())
      return {
        devices: Object.entries(c.devices ?? {}).map(([id, d]) => ({ id, name: d.name }))
      }
    }
    if (path === '/me/player/queue') {
      // ponytail: first 20 upcoming tracks, like the Web API; the panel shows no more than that.
      const next = (await connect(state())).player_state.next_tracks
        .filter((t) => t.uri.startsWith('spotify:track:'))
        .slice(0, 20)
      const queue = await Promise.all(next.map((t) => trackByUri(t.uri).catch(() => null)))
      return { queue: queue.filter(Boolean) }
    }
  }

  if (path === '/me/tracks' && method === 'PUT') {
    await pathfinder('addToLibrary', {
      libraryItemUris: body.ids.map((id: string) => `spotify:track:${id}`),
      interactionId: null
    })
    return null
  }
  if (playlistId && method === 'POST') {
    await pathfinder('addToPlaylist', {
      playlistUri: `spotify:playlist:${playlistId}`,
      playlistItemUris: body.uris,
      newPosition: { moveType: 'BOTTOM_OF_PLAYLIST', fromUid: null },
      interactionId: null
    })
    return null
  }
  if (playlistId && method === 'DELETE') {
    // Removing goes by entry, so find every entry of the track first, as the Web API removes all.
    const uris = new Set((body.items ?? body.tracks).map((t: Raw) => t.uri))
    const uids: string[] = []
    for (let at = 0, total = 1; at < total; at += 100) {
      const content = await playlistItems(playlistId, at, 100)
      total = content.totalCount
      for (const i of content.items) if (uris.has(i.itemV2?.data?.uri)) uids.push(i.uid)
      if (!content.items.length) break
    }
    if (uids.length)
      await pathfinder('removeFromPlaylist', {
        playlistUri: `spotify:playlist:${playlistId}`,
        uids
      })
    return null
  }

  if (path.startsWith('/me/player')) {
    const cmd = path.slice('/me/player'.length)
    if (cmd === '/play' && method === 'PUT') {
      if (body?.context_uri) {
        // Liked Songs has no context URI of its own in the Web API; Connect knows it per user.
        const uri =
          body.context_uri === 'spotify:collection:tracks'
            ? `spotify:user:${(await profile()).id}:collection`
            : body.context_uri
        return play(uri, body.offset?.uri, to, !!body.shuffle)
      }
      if (body?.uris?.length) {
        const uri = body.offset?.uri ?? body.uris[0]
        return play(uri, uri, to)
      }
      // Plain "play" resumes; on another device than the playing one it moves playback there.
      const c = await connect(state())
      if (to && c.active_device_id !== to) return connect(transfer(to))
      return connect(command({ endpoint: 'resume' }))
    }
    if (cmd === '/pause') return connect(command({ endpoint: 'pause' }))
    if (cmd === '/next') return connect(command({ endpoint: 'skip_next' }))
    if (cmd === '/previous') return connect(command({ endpoint: 'skip_prev' }))
    if (cmd === '/seek')
      return connect(command({ endpoint: 'seek_to', value: Number(q.get('position_ms')) }))
    if (cmd === '/shuffle')
      return connect(
        command({ endpoint: 'set_shuffling_context', value: q.get('state') === 'true' })
      )
    if (cmd === '/repeat') {
      const mode = q.get('state')
      await connect(command({ endpoint: 'set_repeating_context', value: mode !== 'off' }))
      return connect(command({ endpoint: 'set_repeating_track', value: mode === 'track' }))
    }
    if (cmd === '/volume') return connect(volume(Number(q.get('volume_percent'))))
    if (cmd === '/queue' && method === 'POST')
      return connect(
        command({
          endpoint: 'add_to_queue',
          track: { uri: q.get('uri'), metadata: { is_queued: 'true' }, provider: 'queue' }
        })
      )
  }

  throw new HttpError(404, `MusicThing can't do ${method} ${path} yet.`)
}

/** One Web API request: `path` relative to /v1 or an absolute `next` URL from a paging object. */
export async function webApi(method: string, path: string, body?: string): Promise<WebApiResponse> {
  const url = new URL(path.startsWith('https://') ? path : BASE + path)
  try {
    const result = await route(
      method,
      url.pathname.replace(/^\/v1/, ''),
      url.searchParams,
      body ? JSON.parse(body) : null
    )
    // Commands answer like the Web API's 204, with no body.
    return {
      status: result === true || result === null ? 204 : 200,
      body: result === true ? null : result
    }
  } catch (err) {
    if (err instanceof SignedOut) return { status: 401, body: null }
    const status = err instanceof HttpError ? err.status : 502
    const message = err instanceof Error ? err.message : String(err)
    return { status, body: { error: { status, message } } }
  }
}
