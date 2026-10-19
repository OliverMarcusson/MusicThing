// Builds librespot into resources/librespot (needs cargo), patched to preload the next track as soon
// as one starts playing instead of 30 s before it ends, so skipping ahead starts without a fetch.
// Upstream also waits for the playing track to finish downloading, which streaming only reaches
// near its end, so that condition goes too.
import { execFileSync } from 'child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { resolve } from 'path'

const VERSION = '0.8.0'
const CACHE = 'node_modules/.cache'
const SRC = `${CACHE}/librespot-playback-${VERSION}`
// Bump the suffix when PATCHES change, so the next run rebuilds.
const MARKER = `resources/librespot/patched-${VERSION}-2`

if (existsSync(MARKER)) process.exit(0)

if (!existsSync(SRC)) {
  mkdirSync(CACHE, { recursive: true })
  const url = `https://static.crates.io/crates/librespot-playback/librespot-playback-${VERSION}.crate`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  writeFileSync(`${SRC}.crate`, Buffer.from(await res.arrayBuffer()))
  execFileSync('tar', ['-xzf', `${SRC}.crate`, '-C', CACHE])
}

const PATCHES = [
  [
    'const PRELOAD_NEXT_TRACK_BEFORE_END_DURATION_MS: u32 = 30000;',
    'const PRELOAD_NEXT_TRACK_BEFORE_END_DURATION_MS: u32 = u32::MAX;'
  ],
  [
    ' as i64)\n                    && stream_loader_controller.range_to_end_available()\n                {',
    ' as i64)\n                {'
  ]
]
const player = `${SRC}/src/player.rs`
let code = readFileSync(player, 'utf8').replaceAll('\r\n', '\n')
for (const [before, after] of PATCHES) {
  if (code.includes(before)) code = code.replace(before, after)
  else if (!code.includes(after))
    throw new Error(`librespot ${VERSION}: ${player} changed: ${before}`)
}
writeFileSync(player, code)

execFileSync(
  'cargo',
  [
    'install',
    'librespot',
    `--version=${VERSION}`,
    '--locked',
    '--force',
    `--root=${CACHE}/librespot`,
    '--config',
    `patch.crates-io.librespot-playback.path="${resolve(SRC).replaceAll('\\', '/')}"`
  ],
  { stdio: 'inherit' }
)
// A running player locks its exe against overwriting but not renaming, so move it aside first;
// MusicThing picks up the new one the next time it starts the player.
const EXE = process.platform === 'win32' ? 'librespot.exe' : 'librespot'
const BIN = `resources/librespot/bin/${EXE}`
mkdirSync('resources/librespot/bin', { recursive: true })
rmSync(`${BIN}.old`, { force: true })
if (existsSync(BIN)) renameSync(BIN, `${BIN}.old`)
copyFileSync(`${CACHE}/librespot/bin/${EXE}`, BIN)
writeFileSync(MARKER, '')
