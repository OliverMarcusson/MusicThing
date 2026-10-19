import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type Paging } from './spotify'

/** The web player says the playlist isn't visible to it (private, and not signed in). */
export class WebPlayerHidden extends Error {}

// `webplayer:<playlist id>:<offset>` pages come from the hidden web player instead of the Web API.
async function loadPage<T>(path: string): Promise<Paging<T> | null> {
  const web = path.match(/^webplayer:(\w+):(\d+)/)
  if (!web) return api<Paging<T>>(path)
  const page = await window.api.webPlaylist(web[1], Number(web[2]))
  if ('error' in page) {
    if (page.error === 'hidden') throw new WebPlayerHidden("This playlist isn't public.")
    throw new Error("Couldn't load this playlist from Spotify's web player.")
  }
  return {
    items: page.items as T[],
    total: page.total,
    next: page.next === null ? null : `webplayer:${web[1]}:${page.next}`
  }
}

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
      const page = await loadPage<T>(next)
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
