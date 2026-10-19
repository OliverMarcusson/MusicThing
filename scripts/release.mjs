// Uploads a release to the homelab update feed that installed copies poll
// (https://musicthing.marcusson.dev/). Bump "version" in package.json and commit first; the feed
// only offers a build whose version is higher than the installed one.
// Usage: bun run release pushes the v<version> tag if it's missing, waits for CI to build it into a
// GitHub Release, and uploads the Windows and Linux builds from there. `bun run release:local`
// builds both here instead (Linux in Docker, build-linux.mjs), skipping the tag and CI.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const HOST = 'root@192.168.0.67'
const DIR = '/srv/compose/edge/sites/musicthing/'

const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'))
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })

const tag = `v${version}`
const out = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim()

if (!process.argv.includes('--local')) {
  if (!out('git', ['ls-remote', '--tags', 'origin', tag])) {
    run('git', ['tag', tag])
    run('git', ['push', 'origin', tag])
  }
  // The tag's CI run takes a few seconds to show up.
  let id
  while (
    !(id = out('gh', [
      'run',
      'list',
      '--workflow',
      'ci.yml',
      '--branch',
      tag,
      '--limit',
      '1',
      '--json',
      'databaseId',
      '--jq',
      '.[0].databaseId'
    ]))
  )
    await new Promise((r) => setTimeout(r, 5000))
  run('gh', ['run', 'watch', id, '--exit-status'])
  run('gh', [
    'release',
    'download',
    tag,
    '-D',
    'dist',
    '--clobber',
    '-p',
    `${name}-${version}-setup.exe*`,
    '-p',
    'latest.yml',
    '-p',
    '*.AppImage',
    '-p',
    '*.deb',
    '-p',
    'latest-linux.yml'
  ])
}

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
