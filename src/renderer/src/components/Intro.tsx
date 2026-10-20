import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { cn } from '@/lib/utils'

// The mark's arcs (see build/icon.svg), top to bottom, with each one's straight-line
// resting shape for the pluck: same ends, control point on the chord.
const ARCS = [
  { d: 'M38 78Q122 40 218 94', flat: 'M38 78Q128 86 218 94', width: 26 },
  { d: 'M52 128Q120 98 198 142', flat: 'M52 128Q125 135 198 142', width: 23 },
  { d: 'M66 176Q118 154 178 188', flat: 'M66 176Q122 182 178 188', width: 20 }
]

const VARIANTS = ['draw', 'pulse', 'pluck'] as const
type Variant = (typeof VARIANTS)[number]

// ponytail: variant picked via localStorage + Alt 1/2/3 until one is chosen; then hardcode it.
function storedVariant(): Variant {
  const v = localStorage.getItem('intro')
  return VARIANTS.includes(v as Variant) ? (v as Variant) : 'draw'
}

/** Covers the window on launch while the mark animates in, then fades away. */
export function Intro(): React.JSX.Element | null {
  const reduce = useReducedMotion()
  const [variant, setVariant] = useState(storedVariant)
  const [run, setRun] = useState(0)
  const [shown, setShown] = useState(true)

  useEffect(() => {
    const t = setTimeout(() => setShown(false), 1300)
    return () => clearTimeout(t)
  }, [run])

  // Alt 1/2/3 replays a variant and keeps it for the next launch.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const v = VARIANTS[Number(e.key) - 1]
      if (!e.altKey || !v) return
      localStorage.setItem('intro', v)
      setVariant(v)
      setShown(true)
      setRun((r) => r + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (reduce) return null
  return (
    <AnimatePresence>
      {shown && (
        <motion.div
          key={run}
          aria-hidden
          className="fixed inset-0 z-50 grid place-items-center bg-background"
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
        >
          <svg
            viewBox="0 0 256 256"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            // The empty Now view's mark, smaller and dimmer; red in the dev app.
            className={cn(
              'size-20 overflow-visible',
              import.meta.env.DEV ? 'text-red-400/60' : 'text-foreground/60'
            )}
          >
            {ARCS.map((arc, i) => (
              <Arc key={i} arc={arc} i={i} variant={variant} />
            ))}
          </svg>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Arc({
  arc,
  i,
  variant
}: {
  arc: (typeof ARCS)[number]
  i: number
  variant: Variant
}): React.JSX.Element {
  if (variant === 'draw')
    // Each arc is drawn left to right, top first.
    return (
      <motion.path
        d={arc.d}
        strokeWidth={arc.width}
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{
          pathLength: { delay: 0.1 + i * 0.1, duration: 0.5, ease: [0.65, 0, 0.35, 1] },
          opacity: { delay: 0.1 + i * 0.1, duration: 0.05 }
        }}
      />
    )
  if (variant === 'pulse')
    // Waves leaving a source below the mark: smallest arc first, each springing outward.
    return (
      <motion.path
        d={arc.d}
        strokeWidth={arc.width}
        style={{ transformBox: 'view-box', transformOrigin: '50% 100%' }}
        initial={{ scale: 0.85, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 0.1 + (2 - i) * 0.1, type: 'spring', duration: 0.6, bounce: 0.15 }}
      />
    )
  // Pluck: each arc starts as a taut straight string and springs into its curve.
  return (
    <motion.path
      strokeWidth={arc.width}
      initial={{ d: arc.flat, opacity: 0 }}
      animate={{ d: arc.d, opacity: 1 }}
      transition={{
        d: { delay: 0.25 + i * 0.08, type: 'spring', stiffness: 220, damping: 13 },
        opacity: { delay: i * 0.08, duration: 0.25 }
      }}
    />
  )
}
