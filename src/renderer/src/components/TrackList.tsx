import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { AudioLines, Check, ListPlus, Music, Play, Plus, Shuffle, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { Player } from '@/lib/player'
import { api, fetchAll, imageUrl, myId, type Image, type Playlist, type Track } from '@/lib/spotify'
import { usePaged } from '@/lib/use-paged'
import { clock, cn } from '@/lib/utils'

// Lists without a context URI play the next 100 loaded tracks as a URI list.
const URI_QUEUE = 100

export type TrackSource<T> = {
  /** A Web API paging endpoint, or null for a list already in hand (`items`). */
  path: string | null
  items?: T[]
  /** Pulls the track out of one page item; null skips it (local files, episodes, removed tracks). */
  pick: (item: T) => Track | null
  /** Playlist or album URI; omit to play a plain URI list. */
  contextUri?: string
}

export function TrackList<T>({
  title,
  subtitle,
  images,
  source,
  playlist,
  showAlbum,
  placeholder,
  onPlayed,
  player
}: {
  title: string
  subtitle?: string
  images: Image[] | null | undefined
  source: TrackSource<T>
  /** The playlist being shown; its tracks get a remove button when you can edit it. */
  playlist?: Playlist
  showAlbum: boolean
  /** Shown in the cover slot when there is no image. */
  placeholder?: React.ReactNode
  /** Called after a click starts a track, unless Shift was held (stay in the list). */
  onPlayed?: () => void
  player: Player
}): React.JSX.Element {
  const paged = usePaged<T>(source.path)
  const { error, done, sentinel } = paged
  const items = source.items ?? paged.items
  const [editable, setEditable] = useState(false)
  useEffect(() => {
    if (!playlist) return
    let live = true
    myId().then(
      (id) => live && setEditable(playlist.collaborative || playlist.owner.id === id),
      () => {}
    )
    return () => {
      live = false
    }
  }, [playlist])
  // Removed tracks hide right away instead of reloading the list.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set())
  const tracks = items.map(source.pick).filter((t): t is Track => !!t?.id && !removed.has(t.uri))
  const currentId = player.state?.item?.id
  const cover = imageUrl(images, 300)

  const play = (i: number): void => {
    const track = tracks[i]
    player.play(
      source.contextUri
        ? { context_uri: source.contextUri, offset: { uri: track.uri } }
        : // offset pins the clicked track first; without it shuffle starts anywhere in the list.
          { uris: tracks.slice(i, i + URI_QUEUE).map((t) => t.uri), offset: { uri: track.uri } }
    )
  }

  // Play starts at the top in order; Shuffle starts on a random track with shuffle on. Shuffle is
  // set after playback starts, so it works even before this PC is the active device, and
  // Spotify then orders the rest around the track that's playing.
  const start = async (shuffle: boolean): Promise<void> => {
    const count = source.contextUri ? tracks.length : Math.min(tracks.length, URI_QUEUE)
    const i = shuffle ? Math.floor(Math.random() * count) : 0
    const track = tracks[i]
    await player.play(
      source.contextUri
        ? { context_uri: source.contextUri, offset: { uri: track.uri } }
        : { uris: tracks.slice(0, URI_QUEUE).map((t) => t.uri), offset: { uri: track.uri } }
    )
    await player.setShuffle(shuffle)
  }

  const cols = cn(
    showAlbum
      ? 'grid-cols-[3ch_minmax(0,3fr)_minmax(0,2fr)_var(--actions)_5ch]'
      : 'grid-cols-[3ch_minmax(0,1fr)_var(--actions)_5ch]',
    editable ? '[--actions:6rem]' : '[--actions:4rem]'
  )

  return (
    <div className="h-full overflow-y-auto">
      <header className="flex items-end gap-6 p-8 pb-6">
        {cover ? (
          <img src={cover} alt="" className="size-40 rounded-md object-cover shadow-xl" />
        ) : (
          <div className="grid size-40 place-items-center rounded-md bg-muted text-muted-foreground/50">
            {placeholder ?? <Music className="size-12" />}
          </div>
        )}
        <div className="min-w-0">
          <h1 className="line-clamp-2 text-3xl leading-[1.35] font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 truncate text-sm text-muted-foreground">{subtitle}</p>}
          <div className="mt-4 flex items-center gap-2">
            <Button
              size="icon"
              className="size-11 rounded-full"
              aria-label="Play"
              title="Play"
              disabled={!tracks.length}
              onClick={(e) => {
                start(false)
                if (!e.shiftKey) onPlayed?.()
              }}
            >
              <Play className="size-5 fill-current" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-11 rounded-full text-muted-foreground hover:text-foreground"
              aria-label="Shuffle"
              title="Shuffle"
              disabled={!tracks.length}
              onClick={(e) => {
                start(true)
                if (!e.shiftKey) onPlayed?.()
              }}
            >
              <Shuffle className="size-5" />
            </Button>
          </div>
        </div>
      </header>

      <div className="px-4 pb-6" role="list">
        {tracks.map((t, i) => {
          const playing = t.id === currentId
          return (
            // The row is a div so it can hold two buttons: a full-row play target and add-to-queue.
            <motion.div
              key={`${t.id}-${i}`}
              role="listitem"
              // Each page fades in top-down; the stagger is capped so long pages don't drag.
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: 'easeOut', delay: Math.min(i % 50, 12) * 0.025 }}
              className={cn(
                'group relative isolate grid h-14 w-full items-center gap-4 rounded-md px-4 text-left text-sm hover:bg-accent/60 has-focus-visible:bg-accent/60 [&>span]:pointer-events-none',
                cols
              )}
            >
              {/* One highlight per list that slides to whichever row is playing. */}
              {playing && (
                <motion.span
                  layoutId={`playing-${source.path}`}
                  className="absolute inset-0 -z-10 rounded-md bg-accent/50"
                  transition={{ type: 'spring', duration: 0.4, bounce: 0.1 }}
                />
              )}
              <button
                type="button"
                aria-label={`Play ${t.name}`}
                onClick={(e) => {
                  play(i)
                  if (!e.shiftKey) onPlayed?.()
                }}
                className="absolute inset-0 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
              <span className="text-right tabular-nums text-muted-foreground">
                {playing ? <AudioLines className="ml-auto size-4 text-foreground" /> : i + 1}
              </span>
              <span className="min-w-0">
                <span className={cn('block truncate', playing && 'font-semibold')}>{t.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {t.artists.map((a) => a.name).join(', ')}
                </span>
              </span>
              {showAlbum && <span className="truncate text-muted-foreground">{t.album?.name}</span>}
              <div className="flex">
                {editable && playlist && (
                  <PlaylistRemove
                    playlistId={playlist.id}
                    uri={t.uri}
                    onRemoved={() => setRemoved((r) => new Set(r).add(t.uri))}
                  />
                )}
                <PlaylistAdd uri={t.uri} />
                <QueueAdd uri={t.uri} player={player} />
              </div>
              <span className="text-right tabular-nums text-muted-foreground">
                {clock(t.duration_ms)}
              </span>
            </motion.div>
          )
        })}
        {error instanceof Error ? (
          <p className="px-4 py-6 text-sm text-destructive">{error.message}</p>
        ) : (
          done &&
          !tracks.length && <p className="px-4 py-6 text-sm text-muted-foreground">No tracks.</p>
        )}
        <div ref={sentinel} />
      </div>
    </div>
  )
}

/** Appears on row hover; the icon confirms the add (or failure) for a moment. */
export function QueueAdd({ uri, player }: { uri: string; player: Player }): React.JSX.Element {
  const [status, setStatus] = useState<'idle' | 'added' | 'failed'>('idle')
  const add = async (e: React.MouseEvent): Promise<void> => {
    // Inside a search result the row itself plays on click; queueing must not also play.
    e.stopPropagation()
    try {
      await player.addToQueue(uri)
      setStatus('added')
    } catch {
      setStatus('failed')
    }
    setTimeout(() => setStatus('idle'), 1500)
  }
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Add to queue"
      title="Add to queue"
      onClick={add}
      className={cn(rowAction, status !== 'idle' && 'opacity-100')}
    >
      {status === 'added' ? (
        <Check className="text-foreground" />
      ) : status === 'failed' ? (
        <X className="text-destructive" />
      ) : (
        <ListPlus />
      )}
    </Button>
  )
}

// A foreground tint, not ghost's accent, so the hover box shows on accent-coloured rows too.
const rowAction =
  'relative z-10 text-muted-foreground opacity-0 hover:bg-foreground/10 dark:hover:bg-foreground/10 group-hover:opacity-100 group-data-[selected=true]:opacity-100 focus-visible:opacity-100'

/**
 * Row button that opens a filterable list of Liked Songs and the playlists you can edit; picking one
 * adds the track.
 */
export function PlaylistAdd({ uri }: { uri: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [added, setAdded] = useState(false)

  // Refetched on each open so new playlists show up; it's two small requests.
  useEffect(() => {
    if (!open) return
    let live = true
    Promise.all([myId(), fetchAll<Playlist | null>('/me/playlists?limit=50')]).then(
      ([me, all]) =>
        live &&
        setPlaylists(
          all.filter((p): p is Playlist => !!p && (p.owner.id === me || p.collaborative))
        ),
      (e) => live && setError(e instanceof Error ? e : new Error(String(e)))
    )
    return () => {
      live = false
    }
  }, [open])

  // Liked Songs saves the track rather than appending it to a playlist.
  const add = async (p: Playlist | null): Promise<void> => {
    try {
      await api(p ? `/playlists/${p.id}/items` : '/me/tracks', {
        method: p ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p ? { uris: [uri] } : { ids: [uri.split(':').pop()] })
      })
      setOpen(false)
      setAdded(true)
      setTimeout(() => setAdded(false), 1500)
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setError(null)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Add to playlist"
          title="Add to playlist"
          // Inside a search result the row plays on click; opening the list must not also play.
          onClick={(e) => e.stopPropagation()}
          className={cn(rowAction, (open || added) && 'opacity-100')}
        >
          {added ? <Check className="text-foreground" /> : <Plus />}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-64 p-0"
        // React events bubble through the portal; keep them away from the row and the search palette.
        onClick={(e) => e.stopPropagation()}
        onPointerMove={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Command>
          <CommandInput placeholder="Add to playlist" />
          <CommandList className="max-h-72">
            {error ? (
              <p className="p-3 text-sm text-destructive">{error.message}</p>
            ) : playlists ? (
              <>
                <CommandEmpty>No playlists.</CommandEmpty>
                <CommandItem value="liked" keywords={['Liked Songs']} onSelect={() => add(null)}>
                  <span className="truncate">Liked Songs</span>
                </CommandItem>
                {playlists.map((p) => (
                  <CommandItem key={p.id} value={p.id} keywords={[p.name]} onSelect={() => add(p)}>
                    <span className="truncate">{p.name}</span>
                  </CommandItem>
                ))}
              </>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** Removes every copy of the track from the playlist; a failure shows on the icon for a moment. */
function PlaylistRemove({
  playlistId,
  uri,
  onRemoved
}: {
  playlistId: string
  uri: string
  onRemoved: () => void
}): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  const remove = async (): Promise<void> => {
    try {
      // The Feb 2026 API renamed the body's `tracks` to `items`; send both like the reads accept both.
      await api(`/playlists/${playlistId}/items`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ uri }], tracks: [{ uri }] })
      })
      onRemoved()
    } catch {
      setFailed(true)
      setTimeout(() => setFailed(false), 1500)
    }
  }
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Remove from playlist"
      title="Remove from playlist"
      onClick={remove}
      className={cn(rowAction, failed && 'opacity-100')}
    >
      {failed ? <X className="text-destructive" /> : <Trash2 />}
    </Button>
  )
}
