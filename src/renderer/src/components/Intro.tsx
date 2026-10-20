import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { cn } from '@/lib/utils'

// The mark's arcs (see build/icon.svg), top to bottom.
const ARCS = [
  { d: 'M38 78Q122 40 218 94', width: 26 },
  { d: 'M52 128Q120 98 198 142', width: 23 },
  { d: 'M66 176Q118 154 178 188', width: 20 }
]

/** Covers the window on launch while the mark pulses in, then fades away. */
export function Intro(): React.JSX.Element | null {
  const reduce = useReducedMotion()
  const [shown, setShown] = useState(true)

  useEffect(() => {
    const t = setTimeout(() => setShown(false), 1300)
    return () => clearTimeout(t)
  }, [])

  if (reduce) return null
  return (
    <AnimatePresence>
      {shown && (
        <motion.div
          aria-hidden
          className="fixed inset-0 z-50 flex flex-col bg-background"
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
        >
          {/* Laid out like the empty Now view (title bar, then the mark above its h-9 search
              button), so the mark sits exactly on that one and nothing moves as this fades. */}
          <div className="h-9 shrink-0" />
          <div className="flex flex-1 flex-col items-center justify-center gap-8">
            <svg
              viewBox="0 0 256 256"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              // The empty Now view's mark, red in the dev app included.
              className={cn(
                'size-40 overflow-visible',
                import.meta.env.DEV ? 'text-red-400/80' : 'text-foreground/80'
              )}
            >
              {/* Waves leaving a source below the mark: smallest arc first, each springing outward. */}
              {ARCS.map((arc, i) => (
                <motion.path
                  key={i}
                  d={arc.d}
                  strokeWidth={arc.width}
                  style={{ transformBox: 'view-box', transformOrigin: '50% 100%' }}
                  initial={{ scale: 0.85, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{
                    delay: 0.1 + (2 - i) * 0.1,
                    type: 'spring',
                    duration: 0.6,
                    bounce: 0.15
                  }}
                />
              ))}
            </svg>
            <div className="h-9" />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
