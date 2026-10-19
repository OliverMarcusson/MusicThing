import { useEffect, useState } from 'react'
import { AnimatePresence, motion, MotionConfig } from 'motion/react'
import { Heart } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Extras, NowPlaying, Transport } from '@/components/NowPlaying'
import { Search } from '@/components/Search'
import { Sidebar } from '@/components/Sidebar'
import { TrackList } from '@/components/TrackList'
import { CoverFlow } from '@/components/CoverFlow'
import { useArtAccent } from '@/lib/accent'
import { usePlayer, type Player } from '@/lib/player'
import { imageUrl, Unauthorized, type Album, type Playlist, type Track } from '@/lib/spotify'

export type View =
  | { kind: 'now' }
  | { kind: 'liked' }
  | { kind: 'playlist'; id: string; playlist: Playlist }
  | { kind: 'album'; id: string; album: Album }

export default function App(): React.JSX.Element | null {
  const [authed, setAuthed] = useState<boolean | null>(null)

  useEffect(() => {
    window.api.token().then(
      (t) => setAuthed(!!t),
      () => setAuthed(false)
    )
  }, [])

  if (authed === null) return null
  if (!authed) return <Login onDone={() => setAuthed(true)} />
  return <Shell onSignedOut={() => setAuthed(false)} />
}

function Login({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const login = async (): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      await window.api.login()
      onDone()
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
          {pending ? 'Waiting for browser…' : 'Log in with Spotify'}
        </Button>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </main>
  )
}

function Shell({ onSignedOut }: { onSignedOut: () => void }): React.JSX.Element {
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
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const viewKey = 'id' in view ? view.id : view.kind

  // Now playing carries the bar's controls once there's a track; until then the bar stays.
  const barHidden = view.kind === 'now' && !!player.state?.item

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
      <div className="flex h-screen flex-col">
        <div className="flex min-h-0 flex-1">
          {/* The rail runs to the top edge; only the content column carries the title bar. */}
          <Sidebar view={view} onSelect={setView} />
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Custom title bar: a drag strip in the app's colours. Windows draws its own
                min/max/close buttons over the right end (titleBarOverlay), keeping Snap Layouts. */}
            <div className="h-9 shrink-0 [-webkit-app-region:drag]" />
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
                  {view.kind === 'now' && <NowView player={player} />}
                  {view.kind === 'liked' && (
                    <TrackList<{ track: Track | null }>
                      key="liked"
                      title="Liked Songs"
                      images={null}
                      placeholder={<Heart className="size-14 fill-current text-foreground" />}
                      source={{ path: '/me/tracks?limit=50', pick: (i) => i.track }}
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
          className="shrink-0 overflow-hidden"
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

function NowView({ player }: { player: Player }): React.JSX.Element {
  const track = player.state?.item
  return (
    // Reaches back under the sidebar rail (72px, see Sidebar) so the page centres on the window,
    // like the player bar it replaces, rather than on the space beside the rail.
    <div className="-ml-[72px] flex h-full w-[calc(100%+72px)] flex-col items-center justify-center gap-2 overflow-hidden px-10">
      {track ? (
        <>
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
        </>
      ) : (
        <p className="max-w-xs text-center text-sm text-muted-foreground">
          Nothing playing. Pick something from your library, or press Ctrl K to search.
        </p>
      )}
    </div>
  )
}
