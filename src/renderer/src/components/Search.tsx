import { useEffect, useRef, useState } from 'react'
import { AudioLines, Heart, Music } from 'lucide-react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Skeleton } from '@/components/ui/skeleton'
import type { Player } from '@/lib/player'
import {
  api,
  fetchAll,
  imageUrl,
  type Album,
  type Image,
  type Paging,
  type Playlist,
  type Track
} from '@/lib/spotify'
import { clock, cn } from '@/lib/utils'
import { PlaylistAdd, QueueAdd } from '@/components/TrackList'
import type { View } from '@/App'

type Results = {
  tracks?: Paging<Track>
  albums?: Paging<Album>
  playlists?: Paging<Playlist | null>
}

// The Feb 2026 API caps search at 10 results per type, which suits a quick palette anyway.
const LIMIT = '10'
const DEBOUNCE_MS = 250
const LIBRARY_MAX = 8
const SKELETON_WIDTHS = [
  ['55%', '30%'],
  ['40%', '25%'],
  ['65%', '35%'],
  ['45%', '20%'],
  ['50%', '30%'],
  ['35%', '25%']
]

/** Results fade in top-down once they arrive; the stagger is capped so long lists don't drag. */
const fill = (i: number): { className: string; style: React.CSSProperties } => ({
  className:
    'animate-in fade-in slide-in-from-top-1 duration-300 fill-mode-backwards motion-reduce:animate-none',
  style: { animationDelay: `${Math.min(i, 12) * 25}ms` }
})

type Library = { playlists: Playlist[]; albums: Album[] }
type LibraryHit =
  | { view: View; title: string; subtitle: string; icon: React.ReactNode }
  | { view: View; title: string; subtitle: string; images: Image[] | null }

const PAGES: LibraryHit[] = [
  {
    view: { kind: 'liked' },
    title: 'Liked Songs',
    subtitle: '',
    icon: <Heart className="fill-current" />
  },
  { view: { kind: 'now' }, title: 'Now playing', subtitle: '', icon: <AudioLines /> }
]

// Your own library matches by name first, so "liked songs" or a playlist name jumps straight there.
function matchLibrary(q: string, library: Library | null): LibraryHit[] {
  const needle = q.toLowerCase()
  const hits: LibraryHit[] = [
    ...PAGES,
    ...(library?.playlists ?? []).map((p) => ({
      view: { kind: 'playlist' as const, id: p.id, playlist: p },
      title: p.name,
      subtitle: `Playlist · ${p.owner.display_name ?? ''}`,
      images: p.images
    })),
    ...(library?.albums ?? []).map((a) => ({
      view: { kind: 'album' as const, id: a.id, album: a },
      title: a.name,
      subtitle: `Album · ${a.artists.map((x) => x.name).join(', ')}`,
      images: a.images
    }))
  ]
  return hits.filter((h) => !needle || h.title.toLowerCase().includes(needle)).slice(0, LIBRARY_MAX)
}

export function Search({
  open,
  onOpenChange,
  player,
  onNavigate
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  player: Player
  onNavigate: (view: View) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  // cmdk's onSelect carries no event, so remember whether Shift was down for the last Enter/click.
  const shift = useRef(false)
  // The answer remembers its query, so a newer query shows the skeleton instead of stale results.
  const [answer, setAnswer] = useState<{
    q: string
    results: Results | null
    error: string | null
  } | null>(null)
  const [library, setLibrary] = useState<Library | null>(null)

  // Refresh your playlists and albums each time the palette opens; it's one or two requests.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    Promise.all([
      fetchAll<Playlist | null>('/me/playlists?limit=50'),
      fetchAll<{ album: Album }>('/me/albums?limit=50')
    ]).then(
      ([playlists, albums]) =>
        !cancelled &&
        setLibrary({
          playlists: playlists.filter((p): p is Playlist => !!p),
          albums: albums.map((a) => a.album)
        }),
      () => {}
    )
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    const q = query.trim()
    if (!q) return
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q, type: 'track,album,playlist', limit: LIMIT })
        const results = await api<Results>(`/search?${params}`)
        if (!cancelled) setAnswer({ q, results, error: null })
      } catch (err) {
        if (!cancelled)
          setAnswer({ q, results: null, error: err instanceof Error ? err.message : String(err) })
      }
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  const done = (): void => onOpenChange(false)
  const q = query.trim()
  const loading = !!q && answer?.q !== q
  const shown = q && !loading ? answer?.results : null
  const error = q && !loading ? answer?.error : null
  const tracks = shown?.tracks?.items ?? []
  const albums = shown?.albums?.items ?? []
  const playlists = (shown?.playlists?.items ?? []).filter((p): p is Playlist => !!p)
  const libraryHits = matchLibrary(q, library)

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search"
      description="Search Spotify for tracks, albums and playlists"
      showCloseButton={false}
      // Spotify ranks the results; cmdk's own fuzzy filter would reorder or hide them.
      shouldFilter={false}
      className="sm:max-w-xl"
    >
      <CommandInput
        placeholder="Search your library and Spotify"
        value={query}
        onValueChange={setQuery}
        onKeyDown={(e) => (shift.current = e.shiftKey)}
      />
      <CommandList className="max-h-[60vh]" onPointerDown={(e) => (shift.current = e.shiftKey)}>
        {error && <p className="py-6 text-center text-sm text-destructive">{error}</p>}
        {libraryHits.length > 0 && (
          <CommandGroup heading="Library">
            {libraryHits.map((h, i) => (
              <CommandItem
                key={'id' in h.view ? h.view.id : h.view.kind}
                value={`library:${'id' in h.view ? h.view.id : h.view.kind}`}
                {...fill(i)}
                onSelect={() => {
                  onNavigate(h.view)
                  done()
                }}
              >
                {'icon' in h ? (
                  <span className="grid size-10 shrink-0 place-items-center rounded-sm bg-muted">
                    {h.icon}
                  </span>
                ) : (
                  <Thumb images={h.images} />
                )}
                <Text title={h.title} subtitle={h.subtitle} />
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {loading && (
          <div aria-label="Searching" role="status" className="p-1">
            {SKELETON_WIDTHS.map(([title, artist], i) => (
              <div key={i} className="flex items-center gap-2 px-2 py-1.5">
                <Skeleton className="size-10 shrink-0 rounded-sm" />
                <span className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3.5" style={{ width: title }} />
                  <Skeleton className="h-3 opacity-60" style={{ width: artist }} />
                </span>
              </div>
            ))}
          </div>
        )}
        {shown && !error && <CommandEmpty>No results for “{q}”.</CommandEmpty>}

        {tracks.length > 0 && (
          <CommandGroup heading="Tracks">
            {tracks.map((t, i) => (
              <CommandItem
                key={t.uri}
                value={t.uri}
                className={cn('group', fill(i).className)}
                style={fill(i).style}
                onSelect={() => {
                  // Play inside the album so playback carries on after this track.
                  player.play(
                    t.album?.uri
                      ? { context_uri: t.album.uri, offset: { uri: t.uri } }
                      : { uris: [t.uri], offset: { uri: t.uri } }
                  )
                  if (!shift.current) onNavigate({ kind: 'now' })
                  done()
                }}
              >
                <Thumb images={t.album?.images} />
                <Text title={t.name} subtitle={t.artists.map((a) => a.name).join(', ')} />
                <span className="ml-auto" />
                <PlaylistAdd uri={t.uri} />
                <QueueAdd uri={t.uri} player={player} />
                <span className="text-xs tabular-nums text-muted-foreground">
                  {clock(t.duration_ms)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {albums.length > 0 && (
          <CommandGroup heading="Albums">
            {albums.map((a, i) => (
              <CommandItem
                key={a.uri}
                value={a.uri}
                {...fill(tracks.length + i)}
                onSelect={() => {
                  onNavigate({ kind: 'album', id: a.id, album: a })
                  done()
                }}
              >
                <Thumb images={a.images} />
                <Text title={a.name} subtitle={a.artists.map((x) => x.name).join(', ')} />
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {playlists.length > 0 && (
          <CommandGroup heading="Playlists">
            {playlists.map((p, i) => (
              <CommandItem
                key={p.uri}
                value={p.uri}
                {...fill(tracks.length + albums.length + i)}
                onSelect={() => {
                  onNavigate({ kind: 'playlist', id: p.id, playlist: p })
                  done()
                }}
              >
                <Thumb images={p.images} />
                <Text title={p.name} subtitle={p.owner.display_name ?? ''} />
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  )
}

function Thumb({ images }: { images: Image[] | null | undefined }): React.JSX.Element {
  const url = imageUrl(images, 64)
  return (
    <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-sm bg-muted">
      {url ? (
        <img src={url} alt="" className="size-full object-cover" />
      ) : (
        <Music className="text-muted-foreground/50" />
      )}
    </span>
  )
}

const Text = ({ title, subtitle }: { title: string; subtitle: string }): React.JSX.Element => (
  <span className="min-w-0">
    <span className="block truncate">{title}</span>
    {subtitle && <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>}
  </span>
)
