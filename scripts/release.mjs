// Uploads the installer built by `bun run build:win`, plus the Linux builds from CI, to the
// homelab update feed that installed copies poll (https://musicthing.marcusson.dev/). Bump
// "version" in package.json and push its v<version> tag first; the feed only offers a build
// whose version is higher than the installed one.
// Usage: bun run release (builds, then runs this)
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const HOST = 'root@192.168.0.67'
const DIR = '/srv/compose/edge/sites/musicthing/'

const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'))
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })

// Linux can't be built here, so take it from the GitHub Release CI makes for the v<version> tag.
run('gh', [
  'release',
  'download',
  `v${version}`,
  '-D',
  'dist',
  '--clobber',
  '-p',
  '*.AppImage',
  '-p',
  '*.deb',
  '-p',
  'latest-linux.yml'
])

// Files first, the latest*.yml manifests last, so clients never see a manifest for a missing file.
const installer = `dist/${name}-${version}-setup.exe`
run('scp', [
  installer,
  `${installer}.blockmap`,
  `dist/${name}-${version}.AppImage`,
  `dist/${name}_${version}_amd64.deb`,
  'site/index.html',
  `${HOST}:${DIR}`
])
run('scp', ['dist/latest.yml', 'dist/latest-linux.yml', `${HOST}:${DIR}`])
console.log(`Released ${version}`)
