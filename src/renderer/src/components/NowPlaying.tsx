import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  Music,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Devices } from '@/components/Devices'
import { Queue } from '@/components/Queue'
import { progressAt, type Player } from '@/lib/player'
import { clock, cn } from '@/lib/utils'

const VOLUME_THROTTLE_MS = 150
// What unmuting restores when the app started muted, so there's no earlier level to go back to.
const UNMUTE_PERCENT = 50
const VOLUME_SETTLE_MS = 1500
// Repeat cycles like Spotify's: off, the whole playlist or album, then the current song.
const NEXT_REPEAT = { off: 'context', context: 'track', track: 'off' } as const

export function NowPlaying({
  player,
  onOpen
}: {
  player: Player
  onOpen: () => void
}): React.JSX.Element {
  const track = player.state?.item
  const thumb = track?.album?.images.at(-1)?.url

  return (
    <footer className="relative z-10 grid h-20 shrink-0 bg-background grid-cols-[minmax(0,1fr)_minmax(0,32rem)_minmax(0,1fr)] content-center items-start gap-6 border-t px-6">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 items-center gap-3 self-center rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
      <Transport player={player} />
      <Extras player={player} />
    </footer>
  )
}

/** Shuffle, skip, play/pause, repeat and the seek bar; in the bar and on the Now playing page. */
export function Transport({ player }: { player: Player }): React.JSX.Element {
  const { state, syncedAt } = player
  const [now, setNow] = useState(() => Date.now())
  // Held while dragging so polling doesn't yank the thumb back.
  const [scrub, setScrub] = useState<number | null>(null)

  useEffect(() => {
    if (!state?.is_playing) return
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [state?.is_playing])

  const track = state?.item
  const duration = track?.duration_ms ?? 0
  const position = scrub ?? (state ? progressAt(state, syncedAt, Math.max(now, syncedAt)) : 0)

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Shuffle"
          aria-pressed={!!state?.shuffle_state}
          title="Shuffle"
          disabled={!state}
          // On: the accent colour; off: muted, like the other secondary controls.
          className={cn('mr-1', state?.shuffle_state ? 'text-art' : 'text-muted-foreground')}
          onClick={() => state && player.setShuffle(!state.shuffle_state)}
        >
          <Shuffle />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous"
          // On the first track played this session there's nothing to go back to: restart it.
          disabled={!state}
          onClick={() => (player.history.length ? player.previous() : player.seek(0))}
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
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={
            state?.repeat_state === 'track'
              ? 'Repeat song'
              : state?.repeat_state === 'context'
                ? 'Repeat'
                : 'Repeat off'
          }
          aria-pressed={!!state && state.repeat_state !== 'off'}
          title="Repeat"
          disabled={!state}
          className={cn(
            'ml-1',
            state && state.repeat_state !== 'off' ? 'text-art' : 'text-muted-foreground'
          )}
          onClick={() => state && player.setRepeat(NEXT_REPEAT[state.repeat_state])}
        >
          {state?.repeat_state === 'track' ? <Repeat1 /> : <Repeat />}
        </Button>
      </div>
      <div className="flex h-4 w-full items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
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
  )
}

/** Devices and Jam, the queue drawer, and volume. The drawer opens against the nearest positioned ancestor. */
export function Extras({
  player,
  className
}: {
  player: Player
  className?: string
}): React.JSX.Element {
  const { state } = player
  const [volume, setVolume] = useState<number | null>(null)
  const volumeSentAt = useRef(0)
  const canVolume = state?.device.volume_percent != null
  const level = volume ?? state?.device.volume_percent ?? 0
  // The level the mute button goes back to: the last one muted from or let go of on the slider,
  // not one passed on the way down to zero.
  const audible = useRef(UNMUTE_PERCENT)
  // A level set here stays shown a moment after, while Spotify echoes the levels sent before it,
  // which would otherwise make the slider jump back and forth.
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined)
  const set = (v: number): void => {
    if (v > 0) audible.current = v
    setVolume(v)
    clearTimeout(settle.current)
    settle.current = setTimeout(() => setVolume(null), VOLUME_SETTLE_MS)
    player.setVolume(v)
  }

  return (
    <div
      className={
        // Centred in the bar; Now playing levels it with the seek bar instead (see App).
        cn(
          'flex min-w-0 items-center justify-end gap-2 self-center text-muted-foreground',
          className
        )
      }
    >
      <Devices player={player} />
      <Queue player={player} />
      <Button
        variant="ghost"
        size="icon-sm"
        className="ml-1"
        aria-label={level ? 'Mute' : 'Unmute'}
        title={level ? 'Mute' : 'Unmute'}
        disabled={!canVolume}
        onClick={() => {
          if (level) audible.current = level
          set(level ? 0 : audible.current)
        }}
      >
        {level ? <Volume2 /> : <VolumeX />}
      </Button>
      <Slider
        aria-label="Volume"
        className="w-24"
        disabled={!canVolume}
        value={[level]}
        onValueChange={([v]) => {
          setVolume(v)
          clearTimeout(settle.current)
          // Live feedback while dragging, throttled to stay under the API rate limit.
          if (Date.now() - volumeSentAt.current > VOLUME_THROTTLE_MS) {
            volumeSentAt.current = Date.now()
            player.setVolume(v)
          }
        }}
        onValueCommit={([v]) => set(v)}
      />
    </div>
  )
}
