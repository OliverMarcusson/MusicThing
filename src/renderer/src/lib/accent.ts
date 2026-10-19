import { useEffect } from 'react'

// Pixels sampled per side, hue buckets, and the chroma below which a pixel counts as grey.
const SAMPLE = 32
const BUCKETS = 24
const MIN_CHROMA = 0.15

/**
 * Sets an app-wide colour property (`--art`, `--view-art`) from a cover. main.css turns them
 * into the accent and background wash, fixing lightness so any cover stays readable.
 * Grey covers (and no cover) fall back to the neutral default.
 */
export function useArtAccent(property: string, url: string | null | undefined): void {
  useEffect(() => {
    const root = document.documentElement.style
    if (!url) return void root.removeProperty(property)
    let live = true
    const img = new Image()
    // Spotify's image CDN sends CORS headers, so the canvas stays readable.
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      if (!live) return
      const colour = vibrant(img)
      if (colour) root.setProperty(property, colour)
      else root.removeProperty(property)
    }
    img.onerror = () => live && root.removeProperty(property)
    img.src = url
    return () => {
      live = false
    }
  }, [property, url])
}

// The most colourful hue that also covers a real area: pixels vote for their hue bucket, weighted
// by chroma squared, so a few saturated pixels beat a large washed-out area but not a large vivid one.
function vibrant(img: HTMLImageElement): string | null {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SAMPLE
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE)
  const data = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data

  const buckets = Array.from({ length: BUCKETS }, () => ({ w: 0, r: 0, g: 0, b: 0 }))
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]]
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const chroma = (max - min) / 255
    if (chroma < MIN_CHROMA) continue
    const d = max - min
    const hue = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    const bucket = buckets[Math.floor((hue / 6) * BUCKETS) % BUCKETS]
    const w = chroma * chroma
    bucket.w += w
    bucket.r += r * w
    bucket.g += g * w
    bucket.b += b * w
  }
  const best = buckets.reduce((a, b) => (b.w > a.w ? b : a))
  if (!best.w) return null
  return `rgb(${best.r / best.w} ${best.g / best.w} ${best.b / best.w})`
}
