import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { windowsPowerShellEnv } from '@arlo/sdk';

/** @typedef {{osRelease: string, productName: string, displayVersion: string, build: string}} WindowsEnvironment */
/** @typedef {(WindowsEnvironment & {status: 'observed', source: 'windows-registry'}) |
 * {status: 'unavailable', osRelease: string, reason: 'WINDOWS_METADATA_UNAVAILABLE'}} ObservedWindows */
/** @type {ObservedWindows | undefined} */
let cached;
const command = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); " +
  "$k=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion',$false); " +
  "try { @{productName=$k.GetValue('ProductName');displayVersion=$k.GetValue('DisplayVersion');" +
  "currentBuild=$k.GetValue('CurrentBuildNumber');ubr=$k.GetValue('UBR')} | ConvertTo-Json -Compress } finally {$k.Dispose()}";

/** Selected read-only local metadata, bounded and cached without changing execution policy.
 * @returns {ObservedWindows} */
export function observeWindows() {
  if (!cached) {
    const osRelease = os.release();
    cached = { status: 'unavailable', osRelease, reason: 'WINDOWS_METADATA_UNAVAILABLE' };
    try {
      const value = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8', env: windowsPowerShellEnv(), windowsHide: true,
        timeout: 5_000, maxBuffer: 4_096, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim());
      const text = (/** @type {unknown} */ item) => typeof item === 'string' && item.length > 0 && item.length <= 128 &&
        !/[\x00-\x1f\x7f]/.test(item);
      const base = /^(\d+)\.(\d+)\.(\d+)$/.exec(osRelease);
      if (base && text(value.productName) && text(value.displayVersion) &&
          typeof value.currentBuild === 'string' && /^\d{1,10}$/.test(value.currentBuild) &&
          value.currentBuild === base[3] && Number.isSafeInteger(value.ubr) && value.ubr >= 0 && value.ubr <= 0xffffffff) {
        cached = { status: 'observed', source: 'windows-registry', osRelease,
          productName: value.productName, displayVersion: value.displayVersion,
          build: `${value.currentBuild}.${value.ubr}` };
      }
    } catch { /* Unavailable observation is an evidence gap, never a readiness gate. */ }
  }
  // Each public report owns its flat scalar metadata; callers cannot alter the cache.
  return { ...cached };
}

/** @param {unknown} value
 * @returns {value is WindowsEnvironment} */
export function validWindowsEnvironment(value) {
  if (!value || typeof value !== 'object') return false;
  const item = /** @type {WindowsEnvironment} */ (value);
  if (![item.osRelease, item.productName, item.displayVersion, item.build].every(text =>
    typeof text === 'string' && text.length > 0 && text.length <= 128 && !/[\x00-\x1f\x7f]/.test(text))) return false;
  const base = /^(\d{1,10})\.(\d{1,10})\.(\d{1,10})$/.exec(item.osRelease);
  const build = /^(\d{1,10})\.(\d{1,10})$/.exec(item.build);
  return !!base && !!build && base[3] === build[1] &&
    [...base.slice(1), build[2]].every(part => Number.isSafeInteger(Number(part)) && Number(part) <= 0xffffffff);
}
