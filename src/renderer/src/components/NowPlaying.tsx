import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Music, Pause, Play, SkipBack, SkipForward, Volume2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Queue } from '@/components/Queue'
import { progressAt, type Player } from '@/lib/player'
import { clock } from '@/lib/utils'

const VOLUME_THROTTLE_MS = 150

export function NowPlaying({
  player,
  onOpen
}: {
  player: Player
  onOpen: () => void
}): React.JSX.Element {
  const { state, syncedAt } = player
  const [now, setNow] = useState(() => Date.now())
  // Held while dragging so polling doesn't yank the thumb back.
  const [scrub, setScrub] = useState<number | null>(null)
  const [volume, setVolume] = useState<number | null>(null)
  const volumeSentAt = useRef(0)

  useEffect(() => {
    if (!state?.is_playing) return
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [state?.is_playing])

  const track = state?.item
  const duration = track?.duration_ms ?? 0
  const position = scrub ?? (state ? progressAt(state, syncedAt, Math.max(now, syncedAt)) : 0)
  const thumb = track?.album?.images.at(-1)?.url
  const canVolume = state?.device.volume_percent != null

  return (
    <footer className="relative z-10 grid h-20 shrink-0 bg-background grid-cols-[1fr_minmax(0,32rem)_1fr] items-center gap-6 border-t px-4">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {/* Cross-fade the art so a track change reads as a change, not a flicker. */}
        <span className="relative grid size-12 shrink-0 place-items-center overflow-hidden rounded-sm bg-muted">
          <Music className="size-5 text-muted-foreground/40" />
          <AnimatePresence initial={false}>
            {thumb && (
              <motion.img
                key={thumb}
                src={thumb}
                alt=""
                className="absolute inset-0 size-full"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
              />
            )}
          </AnimatePresence>
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{track?.name ?? 'Nothing playing'}</p>
          <p className="truncate text-xs text-muted-foreground">
            {track?.artists.map((a) => a.name).join(', ')}
          </p>
        </div>
      </button>

      <div className="flex flex-col items-center gap-1">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous"
            // Nothing to go back to before the first track played this session.
            disabled={!state || player.history.length === 0}
            onClick={player.previous}
          >
            <SkipBack className="fill-current" />
          </Button>
          <Button
            size="icon"
            className="rounded-full"
            aria-label={state?.is_playing ? 'Pause' : 'Play'}
            onClick={player.toggle}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={state?.is_playing ? 'pause' : 'play'}
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.5, opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                {state?.is_playing ? (
                  <Pause className="fill-current" />
                ) : (
                  <Play className="fill-current" />
                )}
              </motion.span>
            </AnimatePresence>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next"
            disabled={!state}
            onClick={player.next}
          >
            <SkipForward className="fill-current" />
          </Button>
        </div>
        <div className="flex w-full items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
          <span className="w-9 text-right">{clock(position)}</span>
          <Slider
            aria-label="Seek"
            disabled={!track}
            max={duration || 1}
            value={[position]}
            onValueChange={([v]) => setScrub(v)}
            onValueCommit={([v]) => {
              setScrub(null)
              player.seek(v)
            }}
          />
          <span className="w-9">{clock(duration)}</span>
        </div>
      </div>

      <div className="flex min-w-0 items-center justify-end gap-2 text-muted-foreground">
        <Queue player={player} />
        <Volume2 className="ml-2 size-4 shrink-0" />
        <Slider
          aria-label="Volume"
          className="w-24"
          disabled={!canVolume}
          value={[volume ?? state?.device.volume_percent ?? 0]}
          onValueChange={([v]) => {
            setVolume(v)
            // Live feedback while dragging, throttled to stay under the API rate limit.
            if (Date.now() - volumeSentAt.current > VOLUME_THROTTLE_MS) {
              volumeSentAt.current = Date.now()
              player.setVolume(v)
            }
          }}
          onValueCommit={([v]) => {
            setVolume(null)
            player.setVolume(v)
          }}
        />
      </div>
    </footer>
  )
}
