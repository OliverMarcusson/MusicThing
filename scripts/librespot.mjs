// Builds librespot into resources/librespot (needs cargo), with two crates patched:
// - playback: preload the next track as soon as one starts playing instead of 30 s before it ends,
//   so skipping ahead starts without a fetch. Upstream also waits for the playing track to finish
//   downloading, which streaming only reaches near its end, so that condition goes too.
// - core: accept commands whose logging_params is null. A Jam's song changes reach the host's
//   player as a "transfer" sent that way, which upstream rejects as an unknown endpoint, so the
//   player kept playing its own song.
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

// "librespot" in package.json: the crate version, then a suffix to bump when PATCHES change. The
// next run rebuilds, and installed copies with an older player update through the installer
// (src/main/index.ts), since librespot sits outside the app code that updates on its own.
const PLAYER = JSON.parse(readFileSync('package.json', 'utf8')).librespot
const VERSION = PLAYER.split('-')[0]
const CACHE = 'node_modules/.cache'
const MARKER = `resources/librespot/patched-${PLAYER}`

if (existsSync(MARKER)) process.exit(0)

// Crate → file → replacements. One already applied is skipped; one that matches neither way means
// upstream changed, so stop rather than build something unpatched.
const PATCHES = {
  'librespot-playback': {
    'src/player.rs': [
      [
        'const PRELOAD_NEXT_TRACK_BEFORE_END_DURATION_MS: u32 = 30000;',
        'const PRELOAD_NEXT_TRACK_BEFORE_END_DURATION_MS: u32 = u32::MAX;'
      ],
      [
        ' as i64)\n                    && stream_loader_controller.range_to_end_available()\n                {',
        ' as i64)\n                {'
      ]
    ]
  },
  'librespot-core': {
    'src/dealer/protocol/request.rs': [
      ['pub logging_params: LoggingParams,', 'pub logging_params: Option<LoggingParams>,']
    ]
  }
}

const config = []
for (const [crate, files] of Object.entries(PATCHES)) {
  const src = `${CACHE}/${crate}-${VERSION}`
  if (!existsSync(src)) {
    mkdirSync(CACHE, { recursive: true })
    const url = `https://static.crates.io/crates/${crate}/${crate}-${VERSION}.crate`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${url} answered ${res.status}`)
    writeFileSync(`${src}.crate`, Buffer.from(await res.arrayBuffer()))
    execFileSync('tar', ['-xzf', `${src}.crate`, '-C', CACHE])
  }
  for (const [file, patches] of Object.entries(files)) {
    const path = `${src}/${file}`
    let code = readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
    for (const [before, after] of patches) {
      if (code.includes(before)) code = code.replaceAll(before, after)
      else if (!code.includes(after))
        throw new Error(`librespot ${VERSION}: ${path} changed: ${before}`)
    }
    writeFileSync(path, code)
  }
  config.push('--config', `patch.crates-io.${crate}.path="${resolve(src).replaceAll('\\', '/')}"`)
}

execFileSync(
  'cargo',
  [
    'install',
    'librespot',
    `--version=${VERSION}`,
    '--locked',
    '--force',
    `--root=${CACHE}/librespot`,
    ...config
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
