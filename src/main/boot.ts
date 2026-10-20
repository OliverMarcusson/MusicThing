import { app } from 'electron'
import { existsSync, readFileSync, renameSync, rmSync } from 'fs'
import { join } from 'path'

/**
 * The real entry point. index.ts downloads newer app code (an app.asar) into userData/update as
 * next.asar; on the next start it becomes app.asar here, before anything else loads, and runs in
 * place of the installed copy. Once an installer has caught up with it, it's stale and goes.
 */
let main = join(__dirname, 'index.js')
if (app.isPackaged) {
  const dir = join(app.getPath('userData'), 'update')
  const asar = join(dir, 'app.asar')
  const versionFile = join(dir, 'app.version')
  let version = ''
  // Electron reads .asar paths as folders; these renames and deletes are on the files themselves.
  process.noAsar = true
  // Either file can still be held open by a copy of the app that's closing (the installer starts
  // the new one right away); that waits for the next start rather than stopping this one.
  try {
    if (existsSync(join(dir, 'next.asar'))) {
      renameSync(join(dir, 'next.asar'), asar)
      // Downloaded by code from before 1.0.20, it has no version file.
      if (existsSync(join(dir, 'next.version'))) renameSync(join(dir, 'next.version'), versionFile)
      else rmSync(versionFile, { force: true })
    }
  } catch {
    // Swapped in next start.
  } finally {
    process.noAsar = false
  }
  // Reading the version from inside the asar would hold it open for good, and a stale one could
  // then never be removed; only one without a version file is read that way.
  try {
    version = existsSync(versionFile)
      ? readFileSync(versionFile, 'utf8').trim()
      : JSON.parse(readFileSync(join(asar, 'package.json'), 'utf8')).version
  } catch {
    // None staged, or unreadable: run the installed copy.
  }
  if (existsSync(asar) && version.localeCompare(app.getVersion(), undefined, { numeric: true }) > 0)
    main = join(asar, 'out/main/index.js')
  else {
    process.noAsar = true
    try {
      rmSync(asar, { force: true })
      rmSync(versionFile, { force: true })
    } catch {
      // Removed next start.
    } finally {
      process.noAsar = false
    }
  }
}
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the path is only known now
require(main)
