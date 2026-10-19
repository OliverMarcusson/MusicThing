import { createContext, useContext, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { AudioLines, Disc3, Heart, ListMusic } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
  onSelect
}: {
  view: View
  onSelect: (view: View) => void
}): React.JSX.Element {
  const [tab, setTab] = useState<'playlists' | 'albums'>('playlists')
  const [open, setOpen] = useState(false)
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
          <nav className="flex w-64 flex-col gap-0.5 p-2">
            <Row active={isActive('now')} onClick={() => onSelect({ kind: 'now' })}>
              <Tile>
                <AudioLines className="size-4" />
              </Tile>
              <span className="group-data-[open=false]/side:opacity-0 transition-opacity duration-150">
                Now playing
              </span>
            </Row>
            <Row active={isActive('liked')} onClick={() => onSelect({ kind: 'liked' })}>
              <Tile>
                <Heart className="size-4 fill-current" />
              </Tile>
              <span className="group-data-[open=false]/side:opacity-0 transition-opacity duration-150">
                Liked Songs
              </span>
            </Row>
          </nav>

          {/* Icon tabs fit the collapsed rail; the label appears once the panel is open. */}
          <div className="flex w-64 items-center gap-0.5 border-t px-2 pt-2" role="tablist">
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
                  <PlaylistList isActive={isActive} onSelect={onSelect} />
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

function PlaylistList({ isActive, onSelect }: ListProps): React.JSX.Element {
  const { items, error, sentinel } = usePaged<Playlist>('/me/playlists?limit=50')
  return (
    <>
      {items.filter(Boolean).map((p, i) => (
        <Row
          key={p.id}
          index={i}
          active={isActive('playlist', p.id)}
          onClick={() => onSelect({ kind: 'playlist', id: p.id, playlist: p })}
        >
          <Cover images={p.images} />
          <Label title={p.name} subtitle={p.owner.display_name ?? ''} />
        </Row>
      ))}
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

const Label = ({ title, subtitle }: { title: string; subtitle: string }): React.JSX.Element => (
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
