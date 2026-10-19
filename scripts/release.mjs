// Uploads the installer built by `bun run build:win` to the homelab update feed that installed
// copies poll (https://musicthing.marcusson.dev/). Bump "version" in package.json first; the
// feed only offers a build whose version is higher than the installed one.
// Usage: bun run release (builds, then runs this)
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const HOST = 'root@192.168.0.67'
const DIR = '/srv/compose/edge/sites/musicthing/'

const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'))
const run = (cmd, args) =>
  execFileSync(cmd, args, { stdio: 'inherit' })

// Installer and blockmap first, latest.yml last, so clients never see a manifest for a missing file.
const installer = `dist/${name}-${version}-setup.exe`
run('scp', [installer, `${installer}.blockmap`, `${HOST}:${DIR}`])
run('scp', ['dist/latest.yml', `${HOST}:${DIR}`])
console.log(`Released ${version}`)
