# MusicThing

A minimalist desktop Spotify client: Electron, React, shadcn/ui, Tailwind 4 and Motion.

It is a remote for Spotify Connect. The official Spotify app plays the audio and is kept hidden;
MusicThing is the window you use. Requires Spotify Premium.

- Library sidebar (playlists, albums, Liked Songs) that expands on hover
- iPod-style Cover Flow for Now playing, swipeable
- Ctrl+K search, queue drawer, accent colour from album art
- Playlists the Web API refuses are read through a hidden copy of Spotify's web player
  (against Spotify's developer terms; can break when the web player changes)

## Setup

1. Create an app at <https://developer.spotify.com/dashboard> with redirect URI
   `http://127.0.0.1:8888/callback` and the Web API enabled.
2. Copy `.env.example` to `.env` and set `MAIN_VITE_SPOTIFY_CLIENT_ID`.
3. `bun install`, then `bun run dev`.

## Scripts

```bash
bun run dev        # electron-vite dev --watch
bun run typecheck  # node + web
bun run build:win  # installer
bun run release    # build and upload to the update feed
```

## Releasing

Installed copies check `https://docs.marcusson.dev/musicthing/latest.yml` at start-up and every
6 hours, download newer builds in the background, and install them on quit (or via the tray's
"Restart to update"). To ship one:

1. Bump `version` in `package.json`.
2. `bun run release` (needs SSH to the homelab as root; uploads to
   `/srv/compose/edge/sites/musicthing/`, served by the edge Caddy).
