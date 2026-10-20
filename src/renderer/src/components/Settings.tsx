import { useEffect, useId, useState } from 'react'
import { Check, ChevronsUpDown, Heart } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import type { Settings as SettingsValue } from '@/lib/settings'
import { api, imageUrl, type Paging, type Playlist } from '@/lib/spotify'
import { cn } from '@/lib/utils'

const LIKED = { uri: 'spotify:collection:tracks', name: 'Liked Songs' }

export function Settings({
  settings,
  onChange
}: {
  settings: SettingsValue
  onChange: (patch: Partial<SettingsValue>) => void
}): React.JSX.Element {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-xl flex-col gap-1 px-8 pt-6 pb-10">
        <h1 className="mb-5 text-3xl font-semibold">Settings</h1>
        <Row
          label="Show version number"
          checked={settings.showVersion}
          onCheckedChange={(on) => onChange({ showVersion: on })}
        />
        <Row
          label="Always on top"
          checked={settings.alwaysOnTop}
          onCheckedChange={(on) => onChange({ alwaysOnTop: on })}
        />
        <Row
          label="Play a playlist on startup"
          checked={settings.startupOn}
          onCheckedChange={(on) => onChange({ startupOn: on })}
        >
          {settings.startupOn && (
            <PlaylistPicker
              value={settings.startup}
              onChange={(startup) => onChange({ startup })}
            />
          )}
        </Row>
      </div>
    </div>
  )
}

function Row({
  label,
  checked,
  onCheckedChange,
  children
}: {
  label: string
  checked: boolean
  onCheckedChange: (on: boolean) => void
  children?: React.ReactNode
}): React.JSX.Element {
  const id = useId()
  return (
    <section className="border-b py-4 last:border-b-0">
      <div className="flex items-center gap-6">
        <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer text-sm font-medium">
          {label}
        </label>
        <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
      </div>
      {children && <div className="mt-3">{children}</div>}
    </section>
  )
}

/**
 * Liked Songs, then the user's playlists, searchable. All of them load on first open, every page:
 * search only sees what's loaded, and a scroll-triggered page wouldn't start in a popover that
 * mounts after its list is asked for.
 */
function PlaylistPicker({
  value,
  onChange
}: {
  value: SettingsValue['startup']
  onChange: (pick: SettingsValue['startup']) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null)
  useEffect(() => {
    if (!open || playlists) return
    let cancelled = false
    ;(async () => {
      const all: Playlist[] = []
      for (let next: string | null = '/me/playlists?limit=50'; next;) {
        const page: Paging<Playlist> | null = await api<Paging<Playlist>>(next)
        all.push(...(page?.items ?? []))
        next = page?.next ?? null
      }
      return all
    })().then(
      (all) => !cancelled && setPlaylists(all),
      () => !cancelled && setPlaylists([])
    )
    return () => {
      cancelled = true
    }
  }, [open, playlists])
  const pick = (p: { uri: string; name: string }): void => {
    onChange({ uri: p.uri, name: p.name })
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn('w-full justify-between font-normal', !value && 'text-muted-foreground')}
        >
          <span className="truncate">{value?.name ?? 'Choose a playlist'}</span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-0">
        <Command>
          <CommandInput placeholder="Search playlists" />
          <CommandList>
            <CommandEmpty>No playlists found.</CommandEmpty>
            <Item
              label={LIKED.name}
              art={
                <span className="grid size-6 place-items-center rounded-sm bg-muted">
                  <Heart className="size-3 fill-current" />
                </span>
              }
              selected={value?.uri === LIKED.uri}
              onSelect={() => pick(LIKED)}
            />
            {(playlists ?? [])
              .filter((p) => p?.id)
              .map((p) => (
                <Item
                  key={p.id}
                  value={`${p.name} ${p.id}`}
                  label={p.name}
                  art={
                    imageUrl(p.images, 48) ? (
                      <img src={imageUrl(p.images, 48)} alt="" className="size-6 rounded-sm" />
                    ) : (
                      <span className="size-6 rounded-sm bg-muted" />
                    )
                  }
                  selected={value?.uri === p.uri}
                  onSelect={() => pick(p)}
                />
              ))}
            {!playlists && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading playlists…</p>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function Item({
  label,
  value = label,
  art,
  selected,
  onSelect
}: {
  label: string
  value?: string
  art: React.ReactNode
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <CommandItem value={value} onSelect={onSelect}>
      {art}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Check className={cn('ml-auto', selected ? 'opacity-100' : 'opacity-0')} />
    </CommandItem>
  )
}
