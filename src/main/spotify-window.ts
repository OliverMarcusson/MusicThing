import { shell } from 'electron'
import { execFile, spawn, type ChildProcess } from 'child_process'

// Keeps the official Spotify app (the Connect device we control) running but out of sight.
// ponytail: Windows only, user32 via PowerShell Add-Type; no native module needed.
// EnumWindows finds Spotify's windows even when hidden, so a window hidden by an earlier
// run (e.g. a dev restart that skipped cleanup) can always be shown again.
const USER32 = `Add-Type -Language CSharp @'
using System; using System.Collections.Generic; using System.Diagnostics;
using System.Runtime.InteropServices; using System.Text;
public static class SpotifyWin {
  delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(Cb cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  public static List<IntPtr> Find() {
    var pids = new HashSet<uint>();
    foreach (var p in Process.GetProcessesByName("Spotify")) pids.Add((uint)p.Id);
    var found = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains(pid) || GetWindowTextLength(h) == 0) return true;
      var c = new StringBuilder(64); GetClassName(h, c, 64);
      if (c.ToString().StartsWith("Chrome_WidgetWin")) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@`
const FIND = `$w = [SpotifyWin]::Find()
if (Get-Process Spotify -ErrorAction SilentlyContinue) { 'running' }
'windows=' + $w.Count`
const SW_HIDE = 0
const SW_SHOWMINNOACTIVE = 7
const SW_RESTORE = 9

let hidden = false

async function run(action: string): Promise<{ running: boolean; windows: number }> {
  const out = await new Promise<string>((resolve) =>
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `${USER32}\n${FIND}\n${action}`],
      { windowsHide: true },
      (_, stdout) => resolve(stdout ?? '')
    )
  )
  return {
    running: out.includes('running'),
    windows: Number(/windows=(\d+)/.exec(out)?.[1] ?? 0)
  }
}

const apply = (cmd: number): string =>
  `foreach ($h in $w) { [void][SpotifyWin]::ShowWindow($h, ${cmd}) }`
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Starts Spotify if needed and hides its window. */
export async function hideSpotify(): Promise<void> {
  const first = await run(apply(SW_HIDE))
  if (!first.running) await shell.openExternal('spotify:')
  // A fresh launch takes a while to open its window; keep hiding until it has.
  let seen = first.running && first.windows > 0
  for (let i = 0; i < 20 && !seen; i++) {
    await sleep(1000)
    seen = (await run(apply(SW_HIDE))).windows > 0
  }
  // Right after launch Spotify may swap its first window for the main one; catch that too.
  if (!first.running) {
    for (let i = 0; i < 3; i++) {
      await sleep(1500)
      await run(apply(SW_HIDE))
    }
  }
  hidden = true
}

let watcher: ChildProcess | null = null

/**
 * Sends Spotify back into hiding whenever its window is minimized, so minimizing it (or closing
 * it, with Spotify's "close button should minimize" setting on) acts like closing to tray.
 * One long-lived PowerShell loop; it exits on its own if this app dies.
 */
export function watchSpotify(): void {
  if (watcher) return
  const loop = `${USER32}
while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) {
  foreach ($h in [SpotifyWin]::Find()) {
    if ([SpotifyWin]::IsWindowVisible($h) -and [SpotifyWin]::IsIconic($h)) { [void][SpotifyWin]::ShowWindow($h, ${SW_HIDE}); 'hidden' }
  }
  Start-Sleep -Milliseconds 500
}`
  watcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', loop], {
    windowsHide: true
  })
  watcher.stdout?.on('data', (d: Buffer) => {
    if (d.toString().includes('hidden')) hidden = true
  })
  watcher.on('exit', () => (watcher = null))
}

/** Shows the Spotify window again, restored or minimized. */
export async function showSpotify(minimized = false): Promise<void> {
  // A minimized window would be re-hidden immediately, so stop watching first.
  if (minimized) watcher?.kill()
  await run(apply(minimized ? SW_SHOWMINNOACTIVE : SW_RESTORE))
  hidden = false
}

export const spotifyHidden = (): boolean => hidden
