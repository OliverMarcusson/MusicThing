import { useState } from 'react'
import { motion } from 'motion/react'
import { AudioLines, Check, ListPlus, Music, Play, Shuffle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Player } from '@/lib/player'
import { ApiError, imageUrl, type Image, type Track } from '@/lib/spotify'
import { usePaged, WebPlayerHidden } from '@/lib/use-paged'
import { clock, cn } from '@/lib/utils'

// ponytail: Liked Songs has no context URI, so it plays the next 100 loaded tracks as a URI list.
const URI_QUEUE = 100

export type TrackSource<T> = {
  path: string
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
  showAlbum,
  placeholder,
  onPlayed,
  player
}: {
  title: string
  subtitle?: string
  images: Image[] | null | undefined
  source: TrackSource<T>
  showAlbum: boolean
  /** Shown in the cover slot when there is no image. */
  placeholder?: React.ReactNode
  /** Called after a click starts a track, unless Shift was held (stay in the list). */
  onPlayed?: () => void
  player: Player
}): React.JSX.Element {
  // Playlists the Web API refuses (not yours) are read through the hidden web player instead.
  const playlistId = source.contextUri?.match(/^spotify:playlist:(\w+)$/)?.[1]
  const [web, setWeb] = useState(false)
  // Bumped after signing in to the web player, so the list loads again with the new session.
  const [attempt, setAttempt] = useState(0)
  const { items, error, done, sentinel } = usePaged<T>(
    web && playlistId ? `webplayer:${playlistId}:0:${attempt}` : source.path
  )
  if (!web && playlistId && error instanceof ApiError && error.status === 403) setWeb(true)
  const tracks = items.map(source.pick).filter((t): t is Track => !!t?.id)
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
  // ponytail: Liked Songs has no context, so it plays the loaded tracks (first URI_QUEUE).
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

  const cols = showAlbum
    ? 'grid-cols-[3ch_minmax(0,3fr)_minmax(0,2fr)_2rem_3.5rem]'
    : 'grid-cols-[3ch_minmax(0,1fr)_2rem_3.5rem]'

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
              <QueueAdd uri={t.uri} player={player} />
              <span className="text-right tabular-nums text-muted-foreground">
                {clock(t.duration_ms)}
              </span>
            </motion.div>
          )
        })}
        {web && error instanceof Error ? (
          // Even when the web player can't list it either, the playlist still plays, and once
          // it's playing the queue reveals what's coming up.
          <div className="flex items-center gap-4 px-4 py-6">
            <Button
              onClick={(e) => {
                player.play({ context_uri: source.contextUri! })
                if (!e.shiftKey) onPlayed?.()
              }}
            >
              <Play className="fill-current" />
              Play
            </Button>
            {error instanceof WebPlayerHidden && (
              <Button
                variant="secondary"
                onClick={async () => (await window.api.webLogin()) && setAttempt((a) => a + 1)}
              >
                Sign in
              </Button>
            )}
            <p className="text-sm text-muted-foreground">
              {error instanceof WebPlayerHidden
                ? "This playlist isn't public. Sign in to Spotify's web player to see its songs."
                : error.message}
            </p>
          </div>
        ) : error instanceof Error ? (
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
      className={cn(
        // A foreground tint, not ghost's accent, so the hover box shows on accent-coloured rows too.
        'relative z-10 text-muted-foreground opacity-0 hover:bg-foreground/10 dark:hover:bg-foreground/10 group-hover:opacity-100 group-data-[selected=true]:opacity-100 focus-visible:opacity-100',
        status !== 'idle' && 'opacity-100'
      )}
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
