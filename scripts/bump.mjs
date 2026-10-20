// Bumps "version" in package.json and commits just that file as "Release <version>".
// Usage: bun run bump [patch|minor|major] (default patch), then bun run release or release:local.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const level = process.argv[2] ?? 'patch'
const at = ['major', 'minor', 'patch'].indexOf(level)
if (at < 0) throw new Error(`Unknown level ${level}; use patch, minor or major.`)

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const parts = pkg.version.split('.').map(Number)
parts[at]++
parts.fill(0, at + 1)
pkg.version = parts.join('.')
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')

execFileSync('git', ['commit', 'package.json', '-m', `Release ${pkg.version}`], {
  stdio: 'inherit'
})
console.log(`Bumped to ${pkg.version}`)
