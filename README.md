# MusicThing

A minimalist desktop Spotify client: Electron, React, shadcn/ui, Tailwind 4 and Motion.

It plays the audio itself through a bundled [librespot](https://github.com/librespot-org/librespot),
an open-source reimplementation of the official client's protocol, which shows up as a Spotify
Connect device named MusicThing. The official Spotify app isn't needed. Requires Spotify Premium.
(Can break when Spotify changes the protocol.)

- Library sidebar (playlists, albums, Liked Songs) that expands on hover
- iPod-style Cover Flow for Now playing, swipeable
- Ctrl+K search, queue drawer, accent colour from album art
- Spotify Connect device picker, and Jams: start one, share its link, join one from a link
  (Jam endpoints are the desktop app's private ones; can break when Spotify changes them)
- Playlists the Web API refuses are read through a hidden copy of Spotify's web player
  (can break when the web player changes)

## Setup

`bun install`, then `bun run dev`. The first run builds librespot with cargo (a few minutes).

There's one Spotify login: an in-app window signs a hidden copy of Spotify's web player in, and
its token drives the Web API, private playlists, queue editing and the first librespot sign-in
(whose reusable credentials are cached after that). No developer-dashboard app is needed.

## Scripts

```bash
bun run dev        # electron-vite dev --watch
bun run typecheck  # node + web
bun run build:win  # installer
bun run release    # build and upload to the update feed
```

## Releasing

Installed copies check `https://musicthing.marcusson.dev/app.json` at start-up and every
5 minutes and download the new app code (`app.asar`) in the background; the next start runs it
(`src/main/boot.ts`), or right away via "Restart to update". Only a release on a different
Electron goes through the installer (`latest.yml`, electron-updater), silently. To ship one:

1. Bump `version` in `package.json` and commit.
2. `bun run release`. It pushes the `v<version>` tag, waits for CI to build it into a GitHub
   Release, and uploads the Windows and Linux builds to `/srv/compose/edge/sites/musicthing/`,
   served by the edge Caddy (needs SSH to the homelab as root). `bun run release:local` builds
   both here instead, Linux in Docker.

### CI

`.github/workflows/ci.yml` typechecks every push and PR. Pushing a `v*` tag that matches
`package.json` (`git tag v1.0.8 && git push origin v1.0.8`) also builds Windows (NSIS), macOS
(arm64 dmg/zip) and Linux (AppImage/deb) and attaches them to a GitHub Release. Builds are unsigned: macOS users have to run
`xattr -cr /Applications/MusicThing.app` once, and Windows shows SmartScreen. The homelab
update feed still only gets what `bun run release` uploads.
