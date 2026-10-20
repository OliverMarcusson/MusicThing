import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, Laptop, MonitorSpeaker, Smartphone, Speaker, Tv, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { Player } from '@/lib/player'
import { cn } from '@/lib/utils'

type Jam = NonNullable<
  Extract<Awaited<ReturnType<typeof window.api.connectJam>>, { ok: unknown }>['ok']
>

// Connect's device_type, as the official apps name them.
const ICONS: Record<string, typeof Speaker> = {
  computer: Laptop,
  smartphone: Smartphone,
  tablet: Smartphone,
  tv: Tv,
  speaker: Speaker
}

type JamAction = Parameters<typeof window.api.connectJam>[0]

/** The user's Jam, read at start, when the menu opens, and whenever Spotify says it changed. */
function useJam(open: boolean): {
  jam: Jam | null
  problem: string | null
  busy: boolean
  run: (action: JamAction, link?: string) => Promise<boolean>
} {
  const [jam, setJam] = useState<Jam | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const apply = useCallback((r: Awaited<ReturnType<typeof window.api.connectJam>>): boolean => {
    if ('ok' in r) {
      setJam(r.ok)
      setProblem(null)
    } else setProblem(r.message)
    return 'ok' in r
  }, [])
  const read = useCallback(() => window.api.connectJam('current').then(apply), [apply])
  const run = useCallback(
    async (action: JamAction, link?: string) => {
      setBusy(true)
      const r = await window.api.connectJam(action, link)
      setBusy(false)
      return apply(r)
    },
    [apply]
  )
  useEffect(() => {
    read()
  }, [open, read])
  useEffect(() => window.api.onJamChanged(setJam), [])
  return { jam, problem, busy, run }
}

/** Spotify Connect: where playback goes, and Jams (listening together). */
export function Devices({ player }: { player: Player }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const { jam, problem, busy, run } = useJam(open)
  const [link, setLink] = useState('')
  const [copied, setCopied] = useState(false)
  const active = player.state?.device
  const elsewhere = !!active && active.name !== 'MusicThing'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Devices and Jam"
          title={elsewhere ? `Playing on ${active.name}` : 'Devices and Jam'}
          className={cn(
            'relative',
            elsewhere || jam ? 'text-art' : open ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          {jam ? <Users /> : <MonitorSpeaker />}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80 p-2">
        <p className="px-2 pt-1 pb-2 text-xs font-medium text-muted-foreground">Play on</p>
        {player.devices.length ? (
          <ul>
            {player.devices.map((d) => {
              const Icon = ICONS[d.type?.toLowerCase() ?? ''] ?? Speaker
              const current = d.id === active?.id
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    // The current one stays clickable: after a restart Spotify can list a player as
                    // playing that has nothing loaded, and moving playback to it again fixes that.
                    title={current ? 'Play here again' : undefined}
                    onClick={() => player.transfer(d.id)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
                      current && 'text-art'
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{d.name}</span>
                    {current && <span className="text-xs">Playing</span>}
                  </button>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="px-2 pb-2 text-sm text-muted-foreground">No devices found.</p>
        )}

        <div className="mt-2 border-t px-2 pt-3 pb-1">
          <p className="pb-2 text-xs font-medium text-muted-foreground">Jam</p>
          {jam ? (
            <>
              <ul className="mb-3 flex flex-col gap-2">
                {jam.members.map((m) => (
                  <li key={m.id} className="flex items-center gap-2 text-sm">
                    {/* The initial shows until the picture loads, and stays if it can't. */}
                    <span className="relative grid size-6 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-xs">
                      {m.name[0]}
                      {m.image && (
                        <img
                          src={m.image}
                          alt=""
                          className="absolute inset-0 size-full object-cover"
                          onError={(e) => (e.currentTarget.hidden = true)}
                        />
                      )}
                    </span>
                    <span className="truncate">{m.name}</span>
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  className="flex-1"
                  onClick={async () => {
                    await navigator.clipboard.writeText(jam.link)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  }}
                >
                  {copied ? <Check /> : <Copy />}
                  {copied ? 'Copied' : 'Copy invite link'}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => run('leave')}>
                  {jam.owner ? 'End' : 'Leave'}
                </Button>
              </div>
            </>
          ) : (
            <>
              <Button
                size="sm"
                className="w-full"
                disabled={busy || !player.state}
                title={player.state ? undefined : 'Play something first'}
                onClick={() => run('start')}
              >
                Start a Jam
              </Button>
              <form
                className="mt-2 flex gap-2"
                onSubmit={async (e) => {
                  e.preventDefault()
                  if (await run('join', link)) setLink('')
                }}
              >
                <input
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  placeholder="Paste an invite link"
                  aria-label="Jam invite link"
                  className="h-8 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                />
                <Button size="sm" variant="secondary" type="submit" disabled={busy || !link.trim()}>
                  Join
                </Button>
              </form>
            </>
          )}
          {problem && <p className="mt-2 text-xs text-destructive">{problem}</p>}
        </div>
      </PopoverContent>
    </Popover>
  )
}
