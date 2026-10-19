// Builds the Linux AppImage/deb in Docker, the local stand-in for CI's ubuntu job. The source is
// copied into a volume rather than built in place, so Linux's node_modules and librespot binary
// never collide with Windows'. Volumes keep cargo, librespot and node_modules between runs, so
// only the first run pays for the librespot compile.
// Usage: node scripts/build-linux.mjs (needs Docker running); output lands in dist/.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const IMAGE = 'musicthing-linux-builder'
const DOCKERFILE = `
FROM rust:1-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends libasound2-dev pkg-config unzip \\
 && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs \\
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH=/root/.bun/bin:$PATH
`
// Everything but these is replaced each run; these persist in the volume.
const KEEP = ['node_modules', 'resources/librespot', 'dist', 'out', '.git', '.claude']
const BUILD = [
  'set -e',
  'mkdir -p /work/app && cd /work/app',
  `find . -mindepth 1 -maxdepth 1 ${['node_modules', 'resources', '.git'].map((k) => `! -name ${k}`).join(' ')} -exec rm -rf {} +`,
  `tar -C /src ${KEEP.map((k) => `--exclude=./${k}`).join(' ')} -cf - . | tar -xf -`,
  'rm -rf dist',
  'bun install --frozen-lockfile',
  'bun run build:linux --publish never',
  'cp dist/*.AppImage dist/*.deb dist/latest-linux.yml /out/'
].join('\n')

const run = (args, input) =>
  execFileSync('docker', args, { stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'], input })

run(['build', '-t', IMAGE, '-'], DOCKERFILE)
mkdirSync('dist', { recursive: true })
run([
  'run',
  '--rm',
  '-v',
  `${resolve('.')}:/src:ro`,
  '-v',
  `${resolve('dist')}:/out`,
  '-v',
  'musicthing-linux-work:/work',
  '-v',
  'musicthing-linux-cargo:/usr/local/cargo/registry',
  '-e',
  'CSC_IDENTITY_AUTO_DISCOVERY=false',
  IMAGE,
  'bash',
  '-c',
  BUILD
])
console.log('Linux build copied to dist/')
