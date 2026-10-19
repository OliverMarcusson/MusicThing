import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ListMusic, Music } from 'lucide-react'
import { Button } from '@/components/ui/button'
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

/**
 * Read-only "next up" drawer; the Web API can add to the queue but not reorder or jump within it.
 * Renders the toggle button in place and the drawer against the player bar (its positioned
 * ancestor), centred and attached to the bar's top edge.
 */
export function Queue({ player }: { player: Player }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const queue = useQueue(player, open)
  const drawer = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)

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
              <div className="max-h-[min(20rem,40vh)] overflow-y-auto px-1 pb-2">
                {queue === null ? (
                  <p className="px-3 py-6 text-center text-sm text-muted-foreground">Loading…</p>
                ) : queue.length === 0 ? (
                  <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                    Nothing queued.
                  </p>
                ) : (
                  queue.map((t, i) => {
                    const url = imageUrl(t.album?.images, 64)
                    return (
                      <div
                        key={`${t.uri}-${i}`}
                        className="flex items-center gap-3 rounded-md px-3 py-2"
                      >
                        <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-sm bg-muted">
                          {url ? (
                            <img src={url} alt="" className="size-full object-cover" />
                          ) : (
                            <Music className="size-4 text-muted-foreground/50" />
                          )}
                        </span>
                        <span className="min-w-0 text-sm">
                          <span className="block truncate">{t.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {t.artists.map((a) => a.name).join(', ')}
                          </span>
                        </span>
                      </div>
                    )
                  })
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  )
}
