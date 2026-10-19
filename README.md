# MusicThing

A minimalist desktop Spotify client: Electron, React, shadcn/ui, Tailwind 4 and Motion.

It plays the audio itself through a bundled [librespot](https://github.com/librespot-org/librespot),
an open-source reimplementation of the official client's protocol, which shows up as a Spotify
Connect device named MusicThing. The official Spotify app isn't needed. Requires Spotify Premium.
(Against Spotify's terms; can break when Spotify changes the protocol.)

- Library sidebar (playlists, albums, Liked Songs) that expands on hover
- iPod-style Cover Flow for Now playing, swipeable
- Ctrl+K search, queue drawer, accent colour from album art
- Playlists the Web API refuses are read through a hidden copy of Spotify's web player
  (against Spotify's developer terms; can break when the web player changes)

## Setup

1. Create an app at <https://developer.spotify.com/dashboard> with redirect URI
   `http://127.0.0.1:8888/callback` and the Web API enabled.
2. Copy `.env.example` to `.env` and set `MAIN_VITE_SPOTIFY_CLIENT_ID`.
3. `bun install`, then `bun run dev`. The first run builds librespot with cargo (a few minutes)
   and opens a browser once to sign the player in; its credentials are cached after that.

## Scripts

```bash
bun run dev        # electron-vite dev --watch
bun run typecheck  # node + web
bun run build:win  # installer
bun run release    # build and upload to the update feed
```

## Releasing

Installed copies check `https://musicthing.marcusson.dev/latest.yml` at start-up and every
6 hours, download newer builds in the background, and install them on quit (or via the tray's
"Restart to update"). To ship one:

1. Bump `version` in `package.json`, commit, and push a matching tag (`git tag v1.0.10 && git push
origin v1.0.10`). Wait for CI to attach the Linux builds to the GitHub Release.
2. `bun run release` (builds Windows locally, takes Linux from that release; needs SSH to the homelab as root; uploads to
   `/srv/compose/edge/sites/musicthing/`, served by the edge Caddy).

### CI

`.github/workflows/ci.yml` typechecks every push and PR. Pushing a `v*` tag that matches
`package.json` (`git tag v1.0.8 && git push origin v1.0.8`) also builds Windows (NSIS), macOS
(arm64 dmg/zip) and Linux (AppImage/deb) and attaches them to a GitHub Release. It needs the
`MAIN_VITE_SPOTIFY_CLIENT_ID` repo secret. Builds are unsigned: macOS users have to run
`xattr -cr /Applications/MusicThing.app` once, and Windows shows SmartScreen. The homelab
update feed still only gets what `bun run release` uploads.
