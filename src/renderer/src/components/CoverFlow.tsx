import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { animate, motion, useMotionValue, useTransform, type MotionValue } from 'motion/react'
import { Music } from 'lucide-react'
import { useQueue } from '@/components/Queue'
import type { Player } from '@/lib/player'
import { imageUrl, type Track } from '@/lib/spotify'

// How far you can flick ahead or back before Spotify catches up; covers this far out are preloaded.
const REACH = 8
// Horizontal travel that counts as a swipe.
const SWIPE_PX = 60
// Quiet time after the last swipe before the skips are sent to Spotify as one batch.
const COMMIT_MS = 350
// Centre-to-neighbour distance and the tighter stacking beyond it, as fractions of a cover's width.
const NEIGHBOUR = 0.62
const STACK = 0.24
const SPRING = { type: 'spring', stiffness: 220, damping: 30 } as const
// Native Chromium mirror under each cover; the gradient fades it out like the iPod's glossy floor.
const REFLECTION = 'below 2px linear-gradient(transparent 62%, rgb(0 0 0 / 0.32))'

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

/**
 * iPod-style Cover Flow: played tracks tilt away on the left, the queue on the right.
 * Every cover's position, angle and size is a function of one continuous value, its slot plus the
 * drag, so dragging turns the centre cover edge-on as it slides, exactly like the iPod.
 * Swipes only move the flow locally; once you stop, the whole move goes to Spotify in one batch,
 * so flicking fast never waits on, or fights with, Spotify's slower state updates.
 * ponytail: the left side is this session's history; Spotify's recently-played endpoint
 * needs another OAuth scope (and a re-login), add it if history across restarts matters.
 */
export function CoverFlow({ player }: { player: Player }): React.JSX.Element {
  const track = player.state?.item ?? null
  const size = useCoverSize()
  const fetched = useQueue(player, true)
  const { history, pos } = player
  // Repeating one song, it's the only cover: the rest fade out, and won't play until repeat is
  // changed.
  const one = player.state?.repeat_state === 'track'

  // The queue is refetched after each track change, so for a moment it still describes the old
  // track. Remember what it was fetched against, and patch it up until it refreshes.
  const [snap, setSnap] = useState({ fetched, track, pos, history })
  if (snap.fetched !== fetched) setSnap({ fetched, track, pos, history })
  const queue = fetched ?? []
  const stale = snap.track && track && snap.track.uri !== track.uri
  const ahead = queue.findIndex((t) => t.uri === track?.uri)
  const upcoming = (
    !stale
      ? queue
      : pos < snap.pos
        ? // Went back: the tracks stepped over, then the one we left, are next again.
          [...snap.history.slice(history.length + 1), snap.track!, ...queue]
        : ahead >= 0
          ? queue.slice(ahead + 1) // went forward into the queue
          : queue
  ).slice(0, REACH)
  const behind = history.slice(-REACH)
  // How far the flow can move each way.
  const [back, forward] = one ? [0, 0] : [behind.length, upcoming.length]
  const items = [
    ...behind.map((t, i) => ({ t, offset: i - behind.length })),
    ...(track ? [{ t: track, offset: 0 }] : []),
    ...upcoming.map((t, i) => ({ t, offset: i + 1 }))
  ]
  // The covers on the flow's first render, by key; any other cover arrived later and glides in.
  const [firstKeys] = useState(() => new Set(items.map(({ offset }) => pos + offset)))

  // Starting another playlist or album clears the history, which would drop the old centre cover
  // on the spot. Keep it for one more move instead: it slides left with the flow, then fades.
  const [center, setCenter] = useState(track && { t: track, key: pos })
  const [leaving, setLeaving] = useState<{ t: Track; key: number } | null>(null)
  if (track && center?.key !== pos) {
    if (center && center.key < pos && !items.some((i) => pos + i.offset === center.key))
      setLeaving(center)
    setCenter({ t: track, key: pos })
  }

  // Drag in cover slots: -1 means the next cover sits in the centre.
  const drag = useMotionValue(0)
  // Where the flow is headed, in slots from the playing track; not yet confirmed by Spotify.
  const target = useRef(0)
  const committing = useRef(false)
  const settle = (): void => void animate(drag, -target.current, SPRING)
  const recentre = (): void => {
    target.current = 0
    settle()
  }

  // When the track changes every cover moves by the same number of slots; shifting the drag by that
  // amount keeps them on screen exactly where they are, then they glide home. A batch that lands
  // on the cover already in the centre therefore causes no motion at all.
  const lastPos = useRef(pos)
  useLayoutEffect(() => {
    const delta = pos - lastPos.current
    lastPos.current = pos
    if (!delta) return
    // Mid-swipe or mid-batch the target stays on the chosen cover; at rest it follows playback.
    if (target.current || committing.current) target.current -= delta
    drag.jump(drag.get() + delta)
    settle()
  }, [pos, drag]) // eslint-disable-line react-hooks/exhaustive-deps

  // The batch commit runs from a timer, so it reads the latest render through a ref.
  const latest = useRef({ track, upcoming, history, skipBy: player.skipBy })
  useLayoutEffect(() => {
    latest.current = { track, upcoming, history, skipBy: player.skipBy }
  })
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const commit = async (): Promise<void> => {
    const n = target.current
    if (committing.current || !n) return
    const { track, upcoming, history, skipBy } = latest.current
    const to = n > 0 ? upcoming[n - 1] : history.at(n)
    if (!track || !to) return recentre()
    committing.current = true
    const ok = await skipBy(n, n > 0 ? [track, ...upcoming.slice(0, n - 1)] : [], to)
    committing.current = false
    if (!ok) recentre()
    // Swipes made while the batch was in flight go out as the next batch.
    else if (target.current) schedule()
  }
  const schedule = (): void => {
    clearTimeout(timer.current)
    timer.current = setTimeout(commit, COMMIT_MS)
  }
  useEffect(() => () => clearTimeout(timer.current), [])

  // Move the flow to a slot right away; Spotify follows once the swiping stops.
  const goTo = (slot: number): void => {
    target.current = clamp(slot, -back, forward)
    settle()
    schedule()
  }

  // Follows the pointer one slot per neighbour distance, starting from where the flow is headed;
  // rubber-bands past the last cover.
  const follow = (dx: number): void => {
    const at = target.current - dx / (size * NEIGHBOUR)
    const max = forward
    const min = -back
    drag.set(-(at > max ? max + (at - max) * 0.2 : at < min ? min + (at - min) * 0.2 : at))
  }

  // Swipe left for the next track, right for the previous one, by mouse drag, touch or trackpad.
  const swiped = useRef(false)
  const wheel = useRef({
    dx: 0,
    lockedUntil: 0,
    idle: undefined as ReturnType<typeof setTimeout> | undefined
  })

  return (
    <motion.div
      className="relative w-full touch-pan-y [perspective:1100px]"
      style={{ height: size * 1.3 }}
      onPanStart={() => {
        swiped.current = true
        drag.stop()
        clearTimeout(timer.current)
      }}
      onPan={(_, info) => follow(info.offset.x)}
      onPanEnd={(_, info) => {
        // Land on the nearest cover; a flick carries on to the next cover in its direction.
        const at = -drag.get()
        const flick = Math.abs(info.velocity.x) > 500 ? -Math.sign(info.velocity.x) : 0
        const moved = Math.abs(info.offset.x) > SWIPE_PX
        const slot = flick > 0 ? Math.ceil(at) : flick < 0 ? Math.floor(at) : Math.round(at)
        goTo(moved || flick ? slot : target.current)
      }}
      // A drag that ends on a cover would otherwise also count as a click on it.
      onClickCapture={(e) => {
        if (swiped.current) e.stopPropagation()
        swiped.current = false
      }}
      onWheel={(e) => {
        // Two-finger trackpad swipes arrive as horizontal wheel deltas; one cover per gesture.
        // The lock stays on while momentum events keep arriving, so inertia can't skip twice.
        const w = wheel.current
        const now = Date.now()
        if (now < w.lockedUntil) return void (w.lockedUntil = now + 250)
        if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
        w.dx += e.deltaX
        clearTimeout(w.idle)
        clearTimeout(timer.current)
        if (Math.abs(w.dx) < SWIPE_PX) {
          follow(-w.dx)
          // Gesture stopped short of a swipe: let go.
          w.idle = setTimeout(() => {
            w.dx = 0
            settle()
            schedule()
          }, 150)
          return
        }
        goTo(target.current + Math.sign(w.dx))
        w.dx = 0
        w.lockedUntil = now + 250
      }}
    >
      {items.map(({ t, offset }) => (
        <Cover
          // Keyed by place in the play sequence, so a cover keeps its element as it changes slot.
          key={pos + offset}
          track={t}
          offset={offset}
          drag={drag}
          size={size}
          late={!firstKeys.has(pos + offset)}
          hidden={one && offset !== 0}
          onSelect={() => goTo(offset)}
        />
      ))}
      {leaving && (
        <Cover
          key={leaving.key}
          track={leaving.t}
          offset={leaving.key - pos}
          drag={drag}
          size={size}
          late={false}
          onSelect={() => {}}
          onLeft={() => setLeaving(null)}
        />
      )}
    </motion.div>
  )
}

function Cover({
  track,
  offset,
  drag,
  size,
  late,
  hidden = false,
  onSelect,
  onLeft
}: {
  track: Track
  offset: number
  drag: MotionValue<number>
  size: number
  /** Arrived after the flow's first render (see below), so it glides in. */
  late: boolean
  hidden?: boolean
  onSelect: () => void
  /** Makes this the leaving cover: it fades out as the flow settles, then this is called. */
  onLeft?: () => void
}): React.JSX.Element {
  const leaving = !!onLeft
  // The fade overlaps the end of the slide, so the two read as one movement.
  const fade = useMotionValue(hidden ? 0 : 1)
  useEffect(() => {
    if (!onLeft) animate(fade, hidden ? 0 : 1, { duration: 0.3, ease: 'easeOut' })
  }, [hidden]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!onLeft) return
    // A stopped animation (StrictMode's rerun stops the first) may still resolve; only a finished
    // fade removes the cover.
    let live = true
    const fading = animate(fade, 0, { delay: 0.2, duration: 0.35, ease: 'easeOut' })
    fading.then(() => live && onLeft())
    return () => {
      live = false
      fading.stop()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // Slot jumps with the props; the parent shifts the drag in the same frame, so nothing moves.
  // A cover that turns up after the flow is on screen (the queue loads just after the track
  // appears) starts one slot further out, where it's still hidden, and glides in instead of
  // popping in. Covers there when the page opens just sit in place.
  const [enters] = useState(() => late && offset !== 0)
  const slot = useMotionValue(enters ? offset + Math.sign(offset) : offset)
  // The offset last applied; a repeat run with the same offset (StrictMode runs mount effects
  // twice) must leave the glide alone, since jump() would cancel it.
  const applied = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (applied.current === offset) return
    if (applied.current === null && enters) animate(slot, offset, SPRING)
    else slot.jump(offset)
    applied.current = offset
  }, [offset, slot]) // eslint-disable-line react-hooks/exhaustive-deps
  const at = useTransform(() => slot.get() + drag.get())

  // Centre faces you; past one slot covers are fully edge-on and stack tighter, like the iPod.
  const x = useTransform(at, (v) => {
    const a = Math.abs(v)
    return `${Math.sign(v) * (Math.min(a, 1) * NEIGHBOUR + Math.max(a - 1, 0) * STACK) * 100}%`
  })
  const rotateY = useTransform(at, (v) => -clamp(v, -1, 1) * 60)
  const scale = useTransform(at, (v) => 1 - 0.16 * Math.min(Math.abs(v), 1))
  // Covers beyond the neighbours are hidden and fade in as they're dragged into view.
  const opacity = useTransform(() => clamp((2 - Math.abs(at.get())) * 2, 0, 1) * fade.get())
  const zIndex = useTransform(at, (v) => 50 - Math.round(Math.abs(v) * 10))
  // Reads the fade too, so a hidden cover can't be clicked and comes back clickable with its fade.
  const pointerEvents = useTransform(() =>
    leaving || fade.get() < 0.5 || Math.abs(at.get()) > 1.5 ? 'none' : 'auto'
  )

  // One image size for every slot, so a cover doesn't reload when it reaches the centre.
  const art = imageUrl(track.album?.images, 640)
  const neighbour = Math.abs(offset) === 1
  return (
    <motion.button
      type="button"
      tabIndex={neighbour && !leaving && !hidden ? 0 : -1}
      aria-hidden={leaving || hidden || (!neighbour && offset !== 0)}
      aria-label={offset === -1 ? 'Previous track' : offset === 1 ? 'Next track' : track.name}
      onClick={onSelect}
      className="absolute top-0 left-1/2 rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      style={{
        width: size,
        height: size,
        marginLeft: -size / 2,
        x,
        rotateY,
        scale,
        opacity,
        zIndex,
        pointerEvents
      }}
    >
      {art ? (
        <img
          src={art}
          alt=""
          draggable={false}
          className="size-full rounded-sm object-cover"
          style={{ WebkitBoxReflect: REFLECTION }}
        />
      ) : (
        <span
          className="grid size-full place-items-center rounded-sm bg-muted"
          style={{ WebkitBoxReflect: REFLECTION }}
        >
          <Music className="size-1/4 text-muted-foreground/40" />
        </span>
      )}
    </motion.button>
  )
}

// Centre cover edge: 46% of the window height, capped so wide-but-short windows still fit.
function useCoverSize(): number {
  const calc = (): number => Math.round(Math.min(window.innerHeight * 0.46, 360))
  const [size, setSize] = useState(calc)
  useEffect(() => {
    const onResize = (): void => setSize(calc())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}
