import { useEffect, useState } from 'react'
import { AnimatePresence, motion, MotionConfig } from 'motion/react'
import { ArrowDownToLine, Heart, History as HistoryIcon, Search as SearchIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Extras, NowPlaying, Transport } from '@/components/NowPlaying'
import { Search } from '@/components/Search'
import { Sidebar } from '@/components/Sidebar'
import { TrackList } from '@/components/TrackList'
import { CoverFlow } from '@/components/CoverFlow'
import { Intro } from '@/components/Intro'
import { useArtAccent } from '@/lib/accent'
import { usePlayer, type Player } from '@/lib/player'
import { imageUrl, Unauthorized, type Album, type Playlist, type Track } from '@/lib/spotify'

export type View =
  | { kind: 'now' }
  | { kind: 'liked' }
  | { kind: 'history' }
  | { kind: 'playlist'; id: string; playlist: Playlist }
  | { kind: 'album'; id: string; album: Album }

export default function App(): React.JSX.Element | null {
  const [authed, setAuthed] = useState<boolean | null>(null)
  // Set once the sidebar's first page of playlists is in, so the intro covers that load.
  const [libraryReady, setLibraryReady] = useState(false)

  useEffect(() => {
    window.api.token().then(
      (t) => setAuthed(!!t),
      () => setAuthed(false)
    )
  }, [])

  return (
    <>
      <Intro ready={libraryReady || authed === false} />
      {authed === false && <Login onDone={() => setAuthed(true)} />}
      {authed && (
        <Shell onSignedOut={() => setAuthed(false)} onReady={() => setLibraryReady(true)} />
      )}
    </>
  )
}

function Login({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const login = async (): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      if (await window.api.webLogin()) onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="grid h-screen place-items-center">
      <div className="flex w-72 flex-col items-center gap-4 text-center">
        <p className="text-sm text-muted-foreground">
          Controls playback on your Spotify devices. Requires Premium.
        </p>
        <Button onClick={login} disabled={pending} className="w-full">
          {pending ? 'Signing in…' : 'Log in with Spotify'}
        </Button>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </main>
  )
}

function Shell({
  onSignedOut,
  onReady
}: {
  onSignedOut: () => void
  onReady: () => void
}): React.JSX.Element {
  const player = usePlayer()
  const { error } = player

  useEffect(() => {
    if (error instanceof Unauthorized) onSignedOut()
  }, [error, onSignedOut])

  const [view, setView] = useState<View>({ kind: 'now' })
  const [searchOpen, setSearchOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen((o) => !o)
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'u') {
        e.preventDefault()
        window.api.checkForUpdates()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const viewKey = 'id' in view ? view.id : view.kind

  // Now playing carries the bar's controls, or with nothing playing, the way to start something.
  const barHidden = view.kind === 'now'

  // The accent follows the playing track; the background wash follows the cover on screen.
  const trackArt = imageUrl(player.state?.item?.album?.images, 64)
  useArtAccent('--art', trackArt)
  useArtAccent(
    '--view-art',
    view.kind === 'now'
      ? trackArt
      : view.kind === 'playlist'
        ? imageUrl(view.playlist.images, 64)
        : view.kind === 'album'
          ? imageUrl(view.album.images, 64)
          : null
  )

  return (
    // Honour the OS reduced-motion setting for every animation below.
    <MotionConfig reducedMotion="user">
      {/* Clips the hidden bar, which slides below the window rather than collapsing. */}
      <div className="flex h-screen flex-col overflow-hidden">
        <div className="relative flex min-h-0 flex-1">
          <UpdateButton />
          {/* The rail runs to the top edge; only the content column carries the title bar. */}
          <Sidebar view={view} onSelect={setView} onReady={onReady} />
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Custom title bar: a drag strip in the app's colours. Windows draws its own
                min/max/close buttons over the right end (titleBarOverlay), keeping Snap Layouts. */}
            <div className="flex h-9 shrink-0 items-start px-1.5 pt-2 [-webkit-app-region:drag]">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Search"
                title="Search (Ctrl K)"
                className="size-7 text-muted-foreground [-webkit-app-region:no-drag]"
                onClick={() => setSearchOpen(true)}
              >
                <SearchIcon />
              </Button>
            </div>
            <main className="relative min-h-0 flex-1">
              {/* Faint wash of the cover's colour; kept inside main so it never meets the
                  title bar, whose native caption buttons sit on a fixed colour. */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_60%_at_50%_45%,var(--art-wash),transparent_70%)]"
              />
              {/* A short fade marks the view switch; content scrolls inside so the fade is cheap. */}
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={viewKey}
                  className="relative h-full"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15, ease: 'easeOut' }}
                >
                  {view.kind === 'now' && (
                    <NowView player={player} onSearch={() => setSearchOpen(true)} />
                  )}
                  {view.kind === 'liked' && (
                    <TrackList<{ track: Track | null }>
                      key="liked"
                      title="Liked Songs"
                      images={null}
                      placeholder={<Heart className="size-14 fill-current text-foreground" />}
                      source={{
                        path: '/me/tracks?limit=50',
                        pick: (i) => i.track,
                        contextUri: 'spotify:collection:tracks'
                      }}
                      showAlbum
                      player={player}
                      onPlayed={() => setView({ kind: 'now' })}
                    />
                  )}
                  {view.kind === 'history' && (
                    // Played as a list of URIs, from the clicked song on down.
                    <TrackList<Track>
                      key="history"
                      title="History"
                      images={null}
                      placeholder={<HistoryIcon className="size-14 text-foreground" />}
                      source={{ path: null, items: player.recent, pick: (t) => t }}
                      showAlbum
                      player={player}
                      onPlayed={() => setView({ kind: 'now' })}
                    />
                  )}
                  {view.kind === 'playlist' && (
                    <TrackList<{ item?: Track | null; track?: Track | null }>
                      key={view.id}
                      title={view.playlist.name}
                      subtitle={view.playlist.owner.display_name ?? ''}
                      images={view.playlist.images}
                      source={{
                        path: `/playlists/${view.id}/items?limit=100`,
                        // The Feb 2026 API renamed playlist entries' `track` to `item`; accept both.
                        pick: (i) => i.item ?? i.track ?? null,
                        contextUri: view.playlist.uri
                      }}
                      playlist={view.playlist}
                      showAlbum
                      player={player}
                      onPlayed={() => setView({ kind: 'now' })}
                    />
                  )}
                  {view.kind === 'album' && (
                    <TrackList<Track>
                      key={view.id}
                      title={view.album.name}
                      subtitle={view.album.artists.map((a) => a.name).join(', ')}
                      images={view.album.images}
                      source={{
                        path: `/albums/${view.id}/tracks?limit=50`,
                        pick: (t) => t,
                        contextUri: view.album.uri
                      }}
                      showAlbum={false}
                      player={player}
                      onPlayed={() => setView({ kind: 'now' })}
                    />
                  )}
                </motion.div>
              </AnimatePresence>
              {error instanceof Error && !(error instanceof Unauthorized) && (
                <p className="absolute inset-x-0 top-3 text-center text-xs text-destructive">
                  {error.message}
                </p>
              )}
            </main>
          </div>
        </div>
        {/* The bar slides down out of the window while Now playing shows the same controls,
            and back up when you leave. Height and offset move together, so the page grows
            into the space instead of jumping. */}
        <motion.div
          className="shrink-0"
          initial={false}
          animate={{ height: barHidden ? 0 : 'auto' }}
          transition={{ type: 'spring', duration: 0.4, bounce: 0 }}
          inert={barHidden}
        >
          <motion.div
            initial={false}
            animate={{ y: barHidden ? '100%' : 0 }}
            transition={{ type: 'spring', duration: 0.4, bounce: 0 }}
          >
            <NowPlaying player={player} onOpen={() => setView({ kind: 'now' })} />
          </motion.div>
        </motion.div>
        <Search
          open={searchOpen}
          onOpenChange={setSearchOpen}
          player={player}
          onNavigate={setView}
        />
      </div>
    </MotionConfig>
  )
}

type UpdateStatus = Awaited<ReturnType<Window['api']['updateStatus']>>

/** Slides up in the bottom-left corner, above the player bar, once a newer version is found. */
function UpdateButton(): React.JSX.Element {
  const [status, setStatus] = useState<UpdateStatus>('none')
  useEffect(() => {
    window.api.updateStatus().then(setStatus)
    return window.api.onUpdateStatus(setStatus)
  }, [])
  return (
    <AnimatePresence>
      {status !== 'none' && (
        <motion.div
          className="absolute bottom-3 left-3 z-30"
          initial={{ y: 24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 24, opacity: 0 }}
          transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
        >
          <Button
            variant="secondary"
            size="sm"
            className="shadow-lg shadow-black/40"
            // Clickable once downloaded; until then it says what's happening.
            disabled={status !== 'ready'}
            onClick={() => window.api.installUpdate()}
          >
            <ArrowDownToLine />
            {status === 'ready' ? 'Restart to update' : 'Downloading update…'}
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function NowView({
  player,
  onSearch
}: {
  player: Player
  onSearch: () => void
}): React.JSX.Element {
  const track = player.state?.item
  return (
    // Reaches back under the sidebar rail (72px, see Sidebar) so the page centres on the window,
    // like the player bar it replaces, rather than on the space beside the rail.
    <div className="-ml-[72px] flex h-full w-[calc(100%+72px)] flex-col items-center justify-center gap-2 overflow-hidden px-10">
      {/* Empty and playing cross-fade, so the first song arrives instead of popping in. */}
      <AnimatePresence mode="wait" initial={false}>
        {track ? (
          <motion.div
            key="playing"
            className="flex h-full w-full flex-col items-center"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
          >
            <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-2">
              <CoverFlow player={player} />
              {/* The title slides up on track change so the switch is legible. */}
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={track.id}
                  className="text-center"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.2 }}
                >
                  <h1 className="text-2xl font-semibold">{track.name}</h1>
                  <p className="text-muted-foreground">
                    {track.artists.map((a) => a.name).join(', ')}
                  </p>
                </motion.div>
              </AnimatePresence>
            </div>
            {/* The player bar itself, minus the track the page already titles: same height, columns
              and edge insets (the negative margin undoes the page padding), so nothing moves when
              the bar slides away and these take over. */}
            <div className="relative -mx-10 grid h-24 shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,32rem)_minmax(0,1fr)] content-center items-start gap-6 self-stretch px-6 pb-4">
              <span />
              <Transport player={player} />
              {/* Level with the seek bar: the same 16px row at the bottom of the controls block. */}
              <Extras player={player} className="h-4 self-end" />
            </div>
          </motion.div>
        ) : (
          // Nothing playing: the mark, and the way in. The button opens search, same as Ctrl K.
          // The launch Intro copies this layout to land its mark here; keep the two in step.
          <motion.div
            key="empty"
            className="flex flex-col items-center gap-8"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
          >
            <svg
              viewBox="0 0 256 256"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              aria-label="MusicThing"
              // Red in the dev app, so it is never mistaken for the installed one.
              className={cn(
                'size-40',
                import.meta.env.DEV ? 'text-red-400/80' : 'text-foreground/80'
              )}
            >
              <path d="M38 78Q122 40 218 94" strokeWidth="26" />
              <path d="M52 128Q120 98 198 142" strokeWidth="23" />
              <path d="M66 176Q118 154 178 188" strokeWidth="20" />
            </svg>
            <Button variant="ghost" className="gap-2 text-muted-foreground" onClick={onSearch}>
              <SearchIcon />
              <kbd className="font-sans text-sm">Ctrl K</kbd>
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
