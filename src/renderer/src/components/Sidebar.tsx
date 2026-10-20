import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Disc3, Eye, EyeOff, Heart, ListMusic, Pencil, Pin, PinOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { imageUrl, type Album, type Image, type Playlist } from '@/lib/spotify'
import { usePaged } from '@/lib/use-paged'
import { cn } from '@/lib/utils'
import type { View } from '@/App'

// Rows read the panel state so the shared highlight resizes through motion, not CSS.
const PanelOpen = createContext(false)

// The library lists slide in from the side of the tab you picked: albums sit right of playlists.
const slide = {
  enter: (dir: number) => ({ opacity: 0, x: dir * 16 }),
  center: { opacity: 1, x: 0 },
  exit: (dir: number) => ({ opacity: 0, x: dir * -16 })
}
const SLIDE_TRANSITION = { duration: 0.18, ease: 'easeOut' } as const

export function Sidebar({
  view,
  onSelect,
  onReady
}: {
  view: View
  onSelect: (view: View) => void
  /** Called once the first page of playlists has loaded (or failed). */
  onReady: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<'playlists' | 'albums'>('playlists')
  const [hovered, setOpen] = useState(false)
  // A row's menu or rename box holds the panel open, as the pointer and focus leave for them.
  const [held, setHeld] = useState(false)
  const open = hovered || held
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const reduceMotion = useReducedMotion()
  const dir = tab === 'albums' ? 1 : -1
  const isActive = (kind: View['kind'], id?: string): boolean =>
    view.kind === kind && (!id || ('id' in view && view.id === id))

  // Hover intent: a short delay so sweeping the mouse past the rail doesn't pop it open.
  const expand = (delay: number): void => {
    clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setOpen(true), delay)
  }
  const collapse = (): void => {
    clearTimeout(hoverTimer.current)
    setOpen(false)
  }

  return (
    // The rail reserves the collapsed width; the panel overlays the content when expanded.
    <aside className="relative w-[72px] shrink-0">
      <PanelOpen.Provider value={open}>
        <motion.div
          className={cn(
            'group/side absolute inset-y-0 left-0 z-20 flex flex-col overflow-hidden border-r bg-background',
            open && 'shadow-2xl shadow-black/60'
          )}
          data-open={open}
          initial={false}
          animate={{ width: open ? 256 : 72 }}
          transition={reduceMotion ? { duration: 0 } : { type: 'spring', duration: 0.3, bounce: 0 }}
          onMouseEnter={() => expand(150)}
          onMouseLeave={collapse}
          // Keyboard users get the same panel: it opens while focus is inside it.
          onFocus={() => expand(0)}
          onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && collapse()}
        >
          {/* Icon tabs fit the collapsed rail; the label appears once the panel is open.
              Now playing lives behind the player bar's cover, so the panel is only the library. */}
          <div className="flex w-64 items-center gap-0.5 px-2 pt-2" role="tablist">
            {TABS.map(({ id, label, Icon }) => (
              <Button
                key={id}
                role="tab"
                aria-selected={tab === id}
                aria-label={label}
                title={label}
                size="icon-sm"
                variant="ghost"
                className={cn(
                  'relative isolate size-7 hover:bg-transparent',
                  tab !== id && 'text-muted-foreground'
                )}
                onClick={() => setTab(id)}
              >
                {/* One pill that slides to the selected tab. */}
                {tab === id && (
                  <motion.span
                    layoutId="sidebar-tab"
                    className="absolute inset-0 -z-10 rounded-md bg-secondary"
                    transition={{ type: 'spring', duration: 0.3, bounce: 0.15 }}
                  />
                )}
                <Icon />
              </Button>
            ))}
            <span className="relative ml-2 h-4 flex-1 overflow-hidden text-xs font-medium text-muted-foreground group-data-[open=false]/side:opacity-0 transition-opacity duration-150">
              <AnimatePresence initial={false} custom={dir}>
                <motion.span
                  key={tab}
                  className="absolute inset-0"
                  custom={dir}
                  variants={slide}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={SLIDE_TRANSITION}
                >
                  {TABS.find((t) => t.id === tab)?.label}
                </motion.span>
              </AnimatePresence>
            </span>
          </div>

          <div
            className={cn(
              'w-64 flex-1 overflow-x-hidden overflow-y-auto p-2',
              !open && '[scrollbar-width:none]'
            )}
          >
            <AnimatePresence mode="wait" initial={false} custom={dir}>
              <motion.div
                key={tab}
                custom={dir}
                variants={slide}
                initial="enter"
                animate="center"
                exit="exit"
                transition={SLIDE_TRANSITION}
              >
                {tab === 'playlists' ? (
                  <PlaylistList
                    isActive={isActive}
                    onSelect={onSelect}
                    onReady={onReady}
                    onHold={setHeld}
                  />
                ) : (
                  <AlbumList isActive={isActive} onSelect={onSelect} />
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </motion.div>
      </PanelOpen.Provider>
    </aside>
  )
}

const TABS = [
  { id: 'playlists', label: 'Playlists', Icon: ListMusic },
  { id: 'albums', label: 'Albums', Icon: Disc3 }
] as const

type ListProps = {
  isActive: (kind: View['kind'], id?: string) => boolean
  onSelect: (view: View) => void
}

type Prefs = { hidden: string[]; pinned: Playlist[]; names: Record<string, string> }
const NO_PREFS: Prefs = { hidden: [], pinned: [], names: {} }

/** Hidden, pinned and renamed playlists: MusicThing's own, kept on this machine, not on Spotify. */
function usePlaylistPrefs(): [Prefs, React.Dispatch<React.SetStateAction<Prefs>>] {
  const [prefs, setPrefs] = useState<Prefs>(() => {
    try {
      return { ...NO_PREFS, ...JSON.parse(localStorage.getItem('playlist-prefs') ?? '{}') }
    } catch {
      return NO_PREFS
    }
  })
  useEffect(() => localStorage.setItem('playlist-prefs', JSON.stringify(prefs)), [prefs])
  return [prefs, setPrefs]
}

function PlaylistList({
  isActive,
  onSelect,
  onReady,
  onHold
}: ListProps & { onReady: () => void; onHold: (held: boolean) => void }): React.JSX.Element {
  const { items, error, done, sentinel } = usePaged<Playlist>('/me/playlists?limit=50')
  const loaded = items.length > 0 || done || !!error
  useEffect(() => {
    if (loaded) onReady()
  }, [loaded, onReady])

  const [prefs, setPrefs] = usePlaylistPrefs()
  const [showHidden, setShowHidden] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => onHold(menuOpen || renaming !== null), [menuOpen, renaming, onHold])

  // Pins come first, in the order pinned, and are saved whole so they show before their page
  // loads; the loaded copy wins once it's in. Hidden ones stay out unless asked for.
  const loadedById = new Map(items.filter(Boolean).map((p) => [p.id, p]))
  const pinned = new Set(prefs.pinned.map((p) => p.id))
  const hidden = new Set(prefs.hidden)
  const rows = [
    ...prefs.pinned.map((p) => loadedById.get(p.id) ?? p),
    ...[...loadedById.values()].filter(
      (p) => !pinned.has(p.id) && (showHidden || !hidden.has(p.id))
    )
  ]

  // Pinning unhides and hiding unpins, so a playlist is never both.
  const togglePin = (p: Playlist): void =>
    setPrefs((s) => ({
      ...s,
      pinned: pinned.has(p.id) ? s.pinned.filter((x) => x.id !== p.id) : [...s.pinned, p],
      hidden: s.hidden.filter((id) => id !== p.id)
    }))
  const toggleHidden = (p: Playlist): void =>
    setPrefs((s) => ({
      ...s,
      hidden: hidden.has(p.id) ? s.hidden.filter((id) => id !== p.id) : [...s.hidden, p.id],
      pinned: s.pinned.filter((x) => x.id !== p.id)
    }))
  // An empty name, or Spotify's own, drops the local one.
  const rename = (p: Playlist, name: string): void =>
    setPrefs((s) => {
      const names = { ...s.names }
      if (!name.trim() || name.trim() === p.name) delete names[p.id]
      else names[p.id] = name.trim()
      return { ...s, names }
    })

  return (
    <>
      {/* Liked Songs is pinned above the user's playlists. */}
      <Row index={0} active={isActive('liked')} onClick={() => onSelect({ kind: 'liked' })}>
        <Tile>
          <Heart className="size-4 fill-current" />
        </Tile>
        <Label title="Liked Songs" subtitle="" />
      </Row>
      {rows.map((p, i) => {
        const name = prefs.names[p.id] ?? p.name
        return (
          <PlaylistMenu
            key={p.id}
            pinned={pinned.has(p.id)}
            hidden={hidden.has(p.id)}
            onOpenChange={setMenuOpen}
            onPin={() => togglePin(p)}
            onHide={() => toggleHidden(p)}
            onRename={() => setRenaming(p.id)}
          >
            {renaming === p.id ? (
              <RenameRow
                images={p.images}
                name={name}
                original={p.name}
                onDone={(n) => {
                  if (n !== null) rename(p, n)
                  setRenaming(null)
                }}
              />
            ) : (
              <Row
                index={i + 1}
                active={isActive('playlist', p.id)}
                // The renamed title carries through to the playlist's page.
                onClick={() => onSelect({ kind: 'playlist', id: p.id, playlist: { ...p, name } })}
              >
                <Cover images={p.images} />
                <Label
                  title={name}
                  subtitle={
                    <>
                      {pinned.has(p.id) && (
                        <Pin className="mr-1 inline size-3 -translate-y-px rotate-45" />
                      )}
                      {p.owner.display_name ?? ''}
                    </>
                  }
                />
              </Row>
            )}
          </PlaylistMenu>
        )
      })}
      {prefs.hidden.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 w-full justify-start px-2.5 text-xs text-muted-foreground group-data-[open=false]/side:invisible"
          onClick={() => setShowHidden((s) => !s)}
        >
          {showHidden ? 'Leave out hidden' : `Show ${prefs.hidden.length} hidden`}
        </Button>
      )}
      <ListEnd error={error} />
      <div ref={sentinel} />
    </>
  )
}

function AlbumList({ isActive, onSelect }: ListProps): React.JSX.Element {
  const { items, error, sentinel } = usePaged<{ album: Album }>('/me/albums?limit=50')
  return (
    <>
      {items.map(({ album: a }, i) => (
        <Row
          key={a.id}
          index={i}
          active={isActive('album', a.id)}
          onClick={() => onSelect({ kind: 'album', id: a.id, album: a })}
        >
          <Cover images={a.images} />
          <Label title={a.name} subtitle={a.artists.map((x) => x.name).join(', ')} />
        </Row>
      ))}
      <ListEnd error={error} />
      <div ref={sentinel} />
    </>
  )
}

function Row({
  active,
  onClick,
  index,
  children
}: {
  active: boolean
  onClick: () => void
  /** Position in a loaded list; list rows fade in one after another, like the track lists. */
  index?: number
  children: React.ReactNode
}): React.JSX.Element {
  const open = useContext(PanelOpen)
  return (
    <motion.button
      type="button"
      {...(index !== undefined && {
        initial: { opacity: 0, y: 6 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.25, ease: 'easeOut', delay: Math.min(index % 50, 12) * 0.025 }
      })}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative isolate flex h-12 w-full min-w-0 items-center gap-3 rounded-md px-2.5 text-left whitespace-nowrap text-sm outline-none hover:bg-accent/60 group-data-[open=false]/side:hover:bg-transparent focus-visible:ring-[3px] focus-visible:ring-ring/50'
      )}
    >
      {/* One shared highlight that glides to the selected row, showing where you navigated. */}
      {active && (
        <motion.span
          layoutId="sidebar-active"
          layoutDependency={open}
          // Collapsed: a 56px box, 8px in from each side of the 72px rail, centred on the cover.
          className={cn(
            'absolute inset-y-0 left-0 -z-10 rounded-md bg-accent',
            open ? 'w-full' : 'w-14'
          )}
          transition={{ type: 'spring', duration: 0.35, bounce: 0.15 }}
        />
      )}
      {children}
    </motion.button>
  )
}

const Tile = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <span className="grid size-9 shrink-0 place-items-center rounded-sm bg-muted">{children}</span>
)

function Cover({ images }: { images: Image[] | null }): React.JSX.Element {
  const url = imageUrl(images, 64)
  return url ? (
    <img src={url} alt="" loading="lazy" className="size-9 shrink-0 rounded-sm object-cover" />
  ) : (
    <span className="size-9 shrink-0 rounded-sm bg-muted" />
  )
}

/** Right-click menu for a playlist row. Hidden rows (shown on request) are dimmed. */
function PlaylistMenu({
  pinned,
  hidden,
  onOpenChange,
  onPin,
  onHide,
  onRename,
  children
}: {
  pinned: boolean
  hidden: boolean
  onOpenChange: (open: boolean) => void
  onPin: () => void
  onHide: () => void
  onRename: () => void
  children: React.ReactNode
}): React.JSX.Element {
  // Rename hands focus to its text box, so the menu mustn't return it to the row on close.
  const renaming = useRef(false)
  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger className={cn('block', hidden && 'opacity-50')}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={(e) => {
          if (renaming.current) e.preventDefault()
          renaming.current = false
        }}
      >
        <ContextMenuItem onSelect={onPin}>
          {pinned ? <PinOff /> : <Pin />}
          {pinned ? 'Unpin' : 'Pin to top'}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => {
            renaming.current = true
            onRename()
          }}
        >
          <Pencil />
          Rename
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onHide}>
          {hidden ? <Eye /> : <EyeOff />}
          {hidden ? 'Unhide' : 'Hide'}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** The row while renaming: Enter or leaving saves, Escape cancels, empty restores Spotify's name. */
function RenameRow({
  images,
  name,
  original,
  onDone
}: {
  images: Image[] | null
  name: string
  original: string
  onDone: (name: string | null) => void
}): React.JSX.Element {
  const done = useRef(false)
  const finish = (value: string | null): void => {
    if (done.current) return
    done.current = true
    onDone(value)
  }
  return (
    <div className="flex h-12 w-full items-center gap-3 rounded-md bg-accent/60 px-2.5">
      <Cover images={images} />
      <input
        autoFocus
        aria-label="Playlist name"
        defaultValue={name}
        placeholder={original}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => finish(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish(e.currentTarget.value)
          if (e.key === 'Escape') finish(null)
        }}
        className="h-7 min-w-0 flex-1 rounded-sm bg-background/60 px-1.5 text-sm outline-none select-text ring-1 ring-ring/50"
      />
    </div>
  )
}

const Label = ({
  title,
  subtitle
}: {
  title: string
  subtitle: React.ReactNode
}): React.JSX.Element => (
  // Labels fade out when collapsed so no clipped letters peek past the covers.
  <span className="min-w-0 group-data-[open=false]/side:opacity-0 transition-opacity duration-150">
    <span className="block truncate">{title}</span>
    <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
  </span>
)

const ListEnd = ({ error }: { error: unknown }): React.JSX.Element | null =>
  error instanceof Error ? (
    <p className="px-2 py-3 text-xs text-destructive">{error.message}</p>
  ) : null
