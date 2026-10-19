import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, Reorder } from 'motion/react'
import { GripVertical, ListMusic, ListStart, Music, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { Player } from '@/lib/player'
import { api, imageUrl, type Track } from '@/lib/spotify'

/** Upcoming tracks; refetched while enabled whenever the track changes or something is queued. */
export function useQueue(player: Player, enabled: boolean): Track[] | null {
  const [queue, setQueue] = useState<Track[] | null>(null)
  const currentId = player.state?.item?.id
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    api<{ queue: Track[] }>('/me/player/queue').then(
      (res) => !cancelled && setQueue(res?.queue ?? []),
      () => !cancelled && setQueue([])
    )
    return () => {
      cancelled = true
    }
  }, [enabled, currentId, player.queueVersion])
  return queue
}

type QueueRef = { index: number; uid: string }
type ConnectItem = QueueRef & { uri: string }
type Problem = { kind: 'signin' | 'failed'; message: string }

type Loaded = { tracks: Track[]; items: ConnectItem[] | null; problem: Problem | null }

/**
 * The Web API's queue (track details) and Connect's (the uids that reordering and skipping need),
 * fetched together and applied in one update: applied apart, a drop briefly showed one list's
 * old order against the other's new one. `items` is null when Connect isn't available.
 */
function useBothQueues(player: Player, enabled: boolean, attempt: number): Loaded | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const currentId = player.state?.item?.id
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    Promise.all([
      api<{ queue: Track[] }>('/me/player/queue').catch(() => null),
      window.api.connectQueue()
    ]).then(([web, res]) => {
      if (cancelled) return
      setLoaded({
        tracks: web?.queue ?? [],
        items: 'ok' in res ? res.ok : null,
        problem: 'ok' in res ? null : { kind: res.error, message: res.message }
      })
    })
    return () => {
      cancelled = true
    }
  }, [enabled, currentId, player.queueVersion, attempt])
  return loaded
}

type Row = { track: Track; ref?: QueueRef; key: string }

// Title and artist widths for the placeholder rows, varied so they read as a list of songs.
const SKELETON_WIDTHS = [
  ['55%', '35%'],
  ['70%', '25%'],
  ['45%', '40%'],
  ['62%', '30%'],
  ['50%', '22%']
]

// Pairs each Web API track with its Connect entry, walking both lists in order. Tracks that don't
// line up (relinked or just changed) get no entry and stay read-only. Keys follow the uid, so a
// moved row keeps its key and slides instead of remounting; with repeat on, Spotify lists the
// same uids again, so later copies add which repeat they are.
function align(tracks: Track[], items: ConnectItem[] | null): Row[] {
  let from = 0
  const seen = new Map<string, number>()
  return tracks.map((track, i) => {
    const k = items?.findIndex((x, n) => n >= from && x.uri === track.uri) ?? -1
    if (k < 0) return { track, key: `${track.uri}-${i}` }
    from = k + 1
    const { index, uid } = items![k]
    const n = seen.get(uid) ?? 0
    seen.set(uid, n + 1)
    return { track, ref: { index, uid }, key: n ? `${uid}-${n}` : uid }
  })
}

/**
 * "Next up" drawer: drag to reorder, play a track next, or skip straight to it. Renders the
 * toggle button in place and the drawer against the player bar (its positioned ancestor),
 * centred and attached to the bar's top edge.
 */
export function Queue({ player }: { player: Player }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const loaded = useBothQueues(player, open, attempt)
  const tracks = loaded?.tracks ?? null
  const [actionProblem, setActionProblem] = useState<Problem | null>(null)
  const problem = actionProblem ?? loaded?.problem ?? null
  const drawer = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)

  const aligned = useMemo(() => align(loaded?.tracks ?? [], loaded?.items ?? null), [loaded])
  // The order a drag or button asked for shows at once, until the refetched queue (a new
  // `aligned`) replaces it; Spotify takes a second or two to report it.
  const [pending, setPending] = useState<{ base: Row[]; rows: Row[] } | null>(null)
  const rows = pending?.base === aligned ? pending.rows : aligned
  const expect = (next: Row[]): void => setPending({ base: aligned, rows: next })
  const latest = useRef(rows)
  useLayoutEffect(() => {
    latest.current = rows
  })

  const run = async (
    action: Promise<{ ok: true } | { error: Problem['kind']; message: string }>
  ): Promise<void> => {
    const res = await action
    setActionProblem('ok' in res ? null : { kind: res.error, message: res.message })
    player.refreshQueue()
  }

  const dropped = (row: Row): void => {
    const list = latest.current
    const i = list.findIndex((r) => r.key === row.key)
    if (!row.ref || i === aligned.findIndex((r) => r.key === row.key)) return
    const after = i === 0 ? null : list[i - 1].ref
    if (after === undefined) return // dropped below a row Connect doesn't know; nothing to anchor to
    run(window.api.connectMove(row.ref, after))
  }

  // Escape or a click outside the drawer closes it.
  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent): void => {
      const target = e.target as Node
      if (!drawer.current?.contains(target) && !toggle.current?.contains(target)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <Button
        ref={toggle}
        variant="ghost"
        size="icon-sm"
        aria-label="Queue"
        aria-expanded={open}
        title="Queue"
        className={open ? 'text-foreground' : 'text-muted-foreground'}
        onClick={() => setOpen((o) => !o)}
      >
        <ListMusic />
      </Button>

      {/* Clipping wrapper: overlaps the bar's top border by 1px so the drawer reads as part of the
          bar, and clips the slide so it emerges from that edge rather than floating in. */}
      <div className="pointer-events-none absolute bottom-[calc(100%-1px)] left-1/2 w-[32rem] max-w-[calc(100%-2rem)] -translate-x-1/2 overflow-hidden pt-8">
        <AnimatePresence>
          {open && (
            <motion.div
              ref={drawer}
              role="dialog"
              aria-label="Queue"
              className="pointer-events-auto rounded-t-xl border border-b-0 bg-background text-foreground shadow-[0_-12px_40px_-12px_rgb(0_0_0/0.6)]"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', duration: 0.35, bounce: 0 }}
            >
              <p className="px-4 pt-4 pb-2 text-sm font-medium">Next up</p>
              <motion.div
                layoutScroll
                className="max-h-[min(20rem,40vh)] overflow-y-auto px-1 pb-2"
              >
                {tracks === null ? (
                  <div aria-label="Loading the queue" role="status">
                    {SKELETON_WIDTHS.map(([title, artist], i) => (
                      <div key={i} className="flex items-center gap-2 py-2 pr-3 pl-1">
                        <span className="size-4 shrink-0" />
                        <Skeleton className="ml-1 size-9 shrink-0 rounded-sm" />
                        <span className="flex flex-1 flex-col gap-1.5">
                          <Skeleton className="h-3.5" style={{ width: title }} />
                          <Skeleton className="h-3 opacity-60" style={{ width: artist }} />
                        </span>
                      </div>
                    ))}
                  </div>
                ) : rows.length === 0 ? (
                  <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                    Nothing queued.
                  </p>
                ) : (
                  // Rows settle in one after another when the queue arrives; rows added later
                  // (a refetch) come in the same way, and moved rows keep their key, so stay put.
                  <Reorder.Group
                    axis="y"
                    values={rows}
                    onReorder={expect}
                    initial="hidden"
                    animate="shown"
                    variants={{ shown: { transition: { staggerChildren: 0.03 } } }}
                  >
                    {rows.map((row) => (
                      <QueueRow
                        key={row.key}
                        row={row}
                        onDrop={() => dropped(row)}
                        onPlayNext={() => {
                          if (!row.ref) return
                          expect([row, ...rows.filter((r) => r !== row)])
                          run(window.api.connectMove(row.ref, null))
                        }}
                        onSkipTo={() => {
                          if (!row.ref) return
                          expect(rows.slice(rows.indexOf(row) + 1))
                          run(window.api.connectSkipTo(row.ref.uid))
                        }}
                      />
                    ))}
                  </Reorder.Group>
                )}
              </motion.div>
              {problem && (
                <div className="flex items-center gap-3 border-t px-4 py-3 text-xs text-muted-foreground">
                  <p className="flex-1">
                    {problem.kind === 'signin'
                      ? "Sign in to Spotify's web player to reorder and skip within the queue."
                      : problem.message}
                  </p>
                  {problem.kind === 'signin' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={async () => {
                        if (!(await window.api.webLogin())) return
                        setActionProblem(null)
                        setAttempt((a) => a + 1)
                      }}
                    >
                      Sign in
                    </Button>
                  )}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  )
}

function QueueRow({
  row,
  onDrop,
  onPlayNext,
  onSkipTo
}: {
  row: Row
  onDrop: () => void
  onPlayNext: () => void
  onSkipTo: () => void
}): React.JSX.Element {
  const { track: t } = row
  const uid = row.ref?.uid
  const url = imageUrl(t.album?.images, 64)
  return (
    <Reorder.Item
      value={row}
      drag={uid ? 'y' : false}
      onDragEnd={onDrop}
      variants={{
        hidden: { opacity: 0, y: 6 },
        shown: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' } }
      }}
      // Lifted while dragging, so it reads as picked up and passes over its neighbours.
      whileDrag={{ scale: 1.02, boxShadow: '0 12px 30px -10px rgb(0 0 0 / 0.6)', zIndex: 1 }}
      className={
        'group relative flex items-center gap-2 rounded-md bg-background py-2 pr-3 pl-1 select-none hover:bg-accent/60' +
        (uid ? ' cursor-grab active:cursor-grabbing' : '')
      }
    >
      {/* Grip marks the rows that can be dragged; read-only rows keep the space so covers line up. */}
      {uid ? (
        <GripVertical
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground/40 group-hover:text-muted-foreground"
        />
      ) : (
        <span className="size-4 shrink-0" />
      )}
      <span className="ml-1 grid size-9 shrink-0 place-items-center overflow-hidden rounded-sm bg-muted">
        {url ? (
          <img src={url} alt="" draggable={false} className="size-full object-cover" />
        ) : (
          <Music className="size-4 text-muted-foreground/50" />
        )}
      </span>
      <span className="min-w-0 flex-1 text-sm">
        <span className="block truncate">{t.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {t.artists.map((a) => a.name).join(', ')}
        </span>
      </span>
      {uid && (
        <span className="flex opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Play ${t.name} next`}
            title="Play next"
            className="text-muted-foreground hover:bg-foreground/10 dark:hover:bg-foreground/10"
            onClick={onPlayNext}
          >
            <ListStart />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Skip to ${t.name}`}
            title="Skip to here"
            className="text-muted-foreground hover:bg-foreground/10 dark:hover:bg-foreground/10"
            onClick={onSkipTo}
          >
            <Play />
          </Button>
        </span>
      )}
    </Reorder.Item>
  )
}
