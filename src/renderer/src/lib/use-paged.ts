import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type Paging } from './spotify'

/**
 * Infinite list over a Spotify paging endpoint. Attach `sentinel` to an element after the list;
 * the next page loads when it scrolls near view. Changing `path` starts over.
 * ponytail: no cache, every remount refetches; add one if navigation starts to feel slow.
 */
export function usePaged<T>(path: string) {
  const [items, setItems] = useState<T[]>([])
  const [next, setNext] = useState<string | null>(path)
  const [error, setError] = useState<unknown>(null)
  const loading = useRef(false)
  const sentinel = useRef<HTMLDivElement>(null)

  const [current, setCurrent] = useState(path)
  if (current !== path) {
    setCurrent(path)
    setItems([])
    setNext(path)
    setError(null)
  }

  const loadMore = useCallback(async () => {
    if (!next || loading.current) return
    loading.current = true
    try {
      const page = await api<Paging<T>>(next)
      setItems((prev) => [...prev, ...(page?.items ?? [])])
      setNext(page?.next ?? null)
    } catch (err) {
      setError(err)
      setNext(null)
    } finally {
      loading.current = false
    }
  }, [next])

  // A fresh observer per page reports immediately if the sentinel is still visible,
  // so short pages keep loading until the view is filled.
  useEffect(() => {
    const el = sentinel.current
    if (!el || !next) return
    const io = new IntersectionObserver(([e]) => e.isIntersecting && loadMore(), {
      rootMargin: '600px'
    })
    io.observe(el)
    return () => io.disconnect()
  }, [loadMore, next])

  return { items, error, done: !next, sentinel }
}
