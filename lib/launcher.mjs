import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  getPlatformInfo,
  detectInstallations,
  atomicWriteFile,
  atomicCopy,
  chownToRealUser,
} from './platform.mjs';
import { signBinaryAdhoc } from './codesign.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CDP_FLAGS = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'];

export const CDP_MODES = ['native', 'wrapper', 'none'];

const CDP_LAUNCHER_MARKER = 'agy-aio-cdp-launcher';
const PROXY_POSIX_DIR = path.join(REPO_ROOT, 'modules', 'proxy-posix');
const CDP_WRAPPER_APP = 'Antigravity-CDP.app';

const PORT_FLAG = '--remote-debugging-port=0';
const ADDRESS_FLAG = '--remote-debugging-address=127.0.0.1';
const PORT_FLAG_RE = /(^|\s)--remote-debugging-port=0(?=\s|$)/i;
const ADDRESS_FLAG_RE = /(^|\s)--remote-debugging-address(?=\s|=|$)/i;
const DESKTOP_PLACEHOLDER_RE = /(^|\s)(%[UuFf])(?=\s|$)/;

// platformInfo uses `os` for the platform name and `realUserHome` for the
// invoking user's home directory (it differs from os.homedir() under sudo).
function platformOf(info) {
  return info?.platform || info?.os || process.platform;
}

function homeOf(info) {
  return info?.realUserHome || info?.home || info?.homedir || os.homedir();
}

function isRoot(info) {
  if (typeof info?.isRoot === 'boolean') return info.isRoot;
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function resolvePlatformInfo(info) {
  if (info) return info;
  try {
    return getPlatformInfo();
  } catch {
    return {
      platform: process.platform,
      realUserHome: os.homedir(),
      isRoot: typeof process.getuid === 'function' && process.getuid() === 0,
    };
  }
}

function resolveInstallations(installations) {
  if (installations) return installations;
  try {
    return detectInstallations();
  } catch {
    return {};
  }
}

function primaryDesktop(installations) {
  if (!installations || typeof installations !== 'object') return {};
  const candidate =
    installations.primaryDesktop ??
    installations.primaryDesktopInfo ??
    installations.desktop ??
    installations.primary;
  if (typeof candidate === 'string' && candidate.trim()) return { exePath: candidate };
  if (Array.isArray(candidate)) {
    return candidate[0] && typeof candidate[0] === 'object' ? candidate[0] : {};
  }
  if (candidate && typeof candidate === 'object') return candidate;
  if (installations.exePath || installations.appBundlePath) return installations;
  if (Array.isArray(installations.desktop) && installations.desktop[0]) return installations.desktop[0];
  return {};
}

function stringField(value, ...keys) {
  if (!value || typeof value !== 'object') return '';
  for (const key of keys) {
    const field = value[key];
    if (typeof field === 'string' && field.trim()) return field;
  }
  return '';
}

function macAppBundle(installations) {
  const desktop = primaryDesktop(installations);
  const direct = stringField(desktop, 'appBundlePath', 'bundlePath', 'appPath');
  if (direct) return direct;
  const exe = stringField(desktop, 'exePath', 'executablePath', 'path');
  const fromExe = exe.match(/^(.*\.app)(?:[\\/]|$)/i);
  if (fromExe) return fromExe[1];
  return stringField(installations, 'appBundlePath', 'bundlePath');
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function hasPortFlag(text) {
  return PORT_FLAG_RE.test(String(text || ''));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function execCommand(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1);
    return end > 0 ? text.slice(1, end) : text;
  }
  return text.split(/\s+/)[0];
}

function findOnPath(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return '';
}

function permissionFailure(action, target, cause) {
  const detail = [cause?.stderr, cause?.stdout, cause?.message]
    .filter((part) => part !== undefined && part !== null && part !== '')
    .map((part) => String(part).trim())
    .filter(Boolean)
    .join('\n');
  const error = new Error(
    `Permission denied while trying to ${action} "${target}". ` +
      'Run the command again with administrator rights, or choose a location your user owns, then retry.' +
      (detail ? `\n${detail}` : ''),
  );
  error.isPermissionError = true;
  error.cause = cause;
  if (cause && typeof cause.code === 'string') error.code = cause.code;
  return error;
}

function isPermissionFailure(err) {
  if (!err) return false;
  if (err.code === 'EPERM' || err.code === 'EACCES') return true;
  const text = [err.message, err.stderr, err.stdout]
    .filter((part) => part !== undefined && part !== null)
    .map((part) => String(part))
    .join('\n');
  return /Operation not permitted/i.test(text) || /Permission denied/i.test(text);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFileAtomic(dest, content, { mode = 0o644, platformInfo } = {}) {
  return atomicWriteFile(dest, content, { mode, platformInfo });
}

function chownIfPossible(target, platformInfo) {
  try {
    return chownToRealUser(target, platformInfo) !== false;
  } catch {
    return false;
  }
}

function spawnDetached(command, args, options = {}) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', ...options });
  // Detached children report spawn errors asynchronously; swallow them here so
  // a missing binary cannot crash the CLI after launch was attempted.
  child.on('error', () => {});
  child.unref();
  return child.pid ?? null;
}

/* ------------------------------------------------------------------ *
 * Windows helpers
 * ------------------------------------------------------------------ */

const WINDOWS_SCAN_PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dirs = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
)
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in ($dirs | Where-Object { $_ } | Select-Object -Unique)) {
  foreach ($file in (Get-ChildItem -LiteralPath $dir -Recurse -Filter *.lnk -File -ErrorAction SilentlyContinue)) {
    $link = $shell.CreateShortcut($file.FullName)
    if ($link.TargetPath -and (Split-Path -Leaf $link.TargetPath) -eq 'Antigravity.exe') {
      $has = if ([string]$link.Arguments -match '(^|\s)--remote-debugging-port=0(\s|$)') { '1' } else { '0' }
      Write-Output ($has + [char]9 + $file.FullName)
    }
  }
}
`;

function getWindowsCdpStatus() {
  let stdout = '';
  try {
    stdout = String(
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCAN_PS],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 20000 },
      ) || '',
    );
  } catch (err) {
    return {
      supported: true,
      configured: false,
      launchers: [],
      details: {
        shortcuts: [],
        error: [err?.stderr, err?.message]
          .filter((part) => part !== undefined && part !== null && part !== '')
          .map((part) => String(part).trim())
          .filter(Boolean)
          .join('\n'),
      },
    };
  }

  const shortcuts = stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.includes('\t'))
    .map((line) => {
      const tab = line.indexOf('\t');
      return { cdp: line.slice(0, tab).trim() === '1', path: line.slice(tab + 1).trim() };
    })
    .filter((entry) => entry.path);

  const launchers = shortcuts.filter((entry) => entry.cdp).map((entry) => entry.path);
  return {
    supported: true,
    configured: launchers.length > 0,
    launchers,
    details: { shortcuts },
  };
}

/* ------------------------------------------------------------------ *
 * Linux helpers
 * ------------------------------------------------------------------ */

function linuxAppDirs(info) {
  const home = homeOf(info);
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return {
    user: path.join(dataHome, 'applications'),
    system: ['/usr/share/applications', '/usr/local/share/applications'],
  };
}

function desktopFilesIn(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && /antigravity.*\.desktop$/i.test(entry.name))
    .map((entry) => path.join(dir, entry.name));
}

function findDesktopFiles(dirs) {
  const seen = new Set();
  const found = [];
  for (const dir of dirs) {
    for (const file of desktopFilesIn(dir)) {
      if (seen.has(file)) continue;
      seen.add(file);
      found.push(file);
    }
  }
  return found;
}

function desktopExecValues(content) {
  return String(content || '')
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*Exec\s*=\s*(.*)$/i))
    .filter(Boolean)
    .map((match) => match[1].trim());
}

function insertFlagBeforePlaceholder(exec, flag) {
  const match = exec.match(DESKTOP_PLACEHOLDER_RE);
  if (!match) return `${exec} ${flag}`.trim();
  const index = match.index + match[1].length;
  return `${exec.slice(0, index)}${flag} ${exec.slice(index)}`;
}

function addCdpFlags(exec) {
  let value = exec;
  if (!PORT_FLAG_RE.test(value)) value = insertFlagBeforePlaceholder(value, PORT_FLAG);
  // Do not override a debugging address the user set themselves.
  if (!ADDRESS_FLAG_RE.test(value)) value = insertFlagBeforePlaceholder(value, ADDRESS_FLAG);
  return value;
}

function removeCdpFlags(exec) {
  let value = exec;
  for (const flag of [PORT_FLAG, ADDRESS_FLAG]) {
    value = value.replace(new RegExp(`(^|\\s)${escapeRegExp(flag)}(?=\\s|$)`, 'gi'), '');
  }
  return value.replace(/[ \t]{2,}/g, ' ').trim();
}

function updateDesktopContent(content, { undo }) {
  let changed = false;
  let currentExec = '';
  const lines = String(content).split(/\r?\n/).map((line) => {
    const match = line.match(/^(\s*Exec\s*=\s*)(.*)$/i);
    if (!match) return line;
    const next = undo ? removeCdpFlags(match[2]) : addCdpFlags(match[2]);
    currentExec = next;
    if (next !== match[2]) changed = true;
    return match[1] + next;
  });
  return { content: lines.join('\n'), changed, exec: currentExec };
}

function quoteDesktopExec(value) {
  if (!/[\s"'\\]/.test(value)) return value;
  return `"${value.replace(/([\\"])/g, '\\$1')}"`;
}

function linuxExecutable(installations, info) {
  const desktop = primaryDesktop(installations);
  const direct = stringField(desktop, 'exePath', 'executablePath', 'path');
  if (direct) return direct;

  const onPath = findOnPath('antigravity');
  if (onPath) return onPath;

  const dirs = linuxAppDirs(info);
  const [file] = findDesktopFiles([dirs.user, ...dirs.system]);
  if (!file) return '';
  const exec = desktopExecValues(readText(file))[0] || '';
  return execCommand(exec);
}

/* ------------------------------------------------------------------ *
 * Native CDP launcher helpers
 * ------------------------------------------------------------------ */

/**
 * Check whether a binary was produced by the agy-cdp-launcher build and still
 * carries its marker string.
 *
 * Universal Mach-O binaries keep their strings in the second slice (~18.5 KB
 * in), so anything up to 1 MB is read completely; larger files only need the
 * first 64 KB.
 *
 * @param {string} binPath
 * @returns {boolean}
 */
export function hasCdpLauncherMarker(binPath) {
  if (!binPath) return false;

  let stat;
  try {
    stat = fs.statSync(binPath);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size === 0) return false;

  let buf;
  if (stat.size > 1024 * 1024) {
    const fd = fs.openSync(binPath, 'r');
    try {
      const chunk = Buffer.alloc(64 * 1024);
      const bytes = fs.readSync(fd, chunk, 0, chunk.length, 0);
      buf = chunk.subarray(0, bytes);
    } finally {
      fs.closeSync(fd);
    }
  } else {
    buf = fs.readFileSync(binPath);
  }

  return buf.includes(CDP_LAUNCHER_MARKER);
}

/**
 * Report whether the macOS app binary was replaced by the native CDP launcher.
 *
 * @param {string} exePath
 * @returns {boolean}
 */
export function isNativeCdpPatched(exePath) {
  return Boolean(
    exePath &&
      fs.existsSync(`${exePath}.orig`) &&
      fs.existsSync(exePath) &&
      hasCdpLauncherMarker(exePath),
  );
}

function getCdpLauncherPaths(info) {
  const repoBin = path.join(PROXY_POSIX_DIR, 'bin', 'agy-cdp-launcher');
  const cacheDir = path.join(info.dataDir || path.join(homeOf(info), '.agy-aio'), 'bin');
  const cacheBin = path.join(cacheDir, 'agy-cdp-launcher');
  const binPath = fs.existsSync(repoBin) ? repoBin : fs.existsSync(cacheBin) ? cacheBin : null;
  return { repoBin, cacheDir, cacheBin, binPath };
}

/**
 * Build the native CDP launcher and copy it into the user cache.
 *
 * @param {{ universal?: boolean, dryRun?: boolean, platformInfo?: object }} [options]
 */
export function buildCdpLauncher({ universal = true, dryRun = false, platformInfo } = {}) {
  const info = resolvePlatformInfo(platformInfo);
  const platform = platformOf(info);

  if (platform !== 'darwin' && platform !== 'linux') {
    return { built: false, skipped: true };
  }

  const target = platform === 'darwin' && universal ? 'cdp-universal' : 'cdp-launcher';
  if (dryRun) return { built: false, dryRun: true, target };

  execFileSync('make', ['-C', PROXY_POSIX_DIR, target], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300000,
  });

  const { repoBin, cacheBin } = getCdpLauncherPaths(info);
  atomicCopy(repoBin, cacheBin, { mode: 0o755, platformInfo: info });
  return { built: true, binPath: cacheBin };
}

function restoreNativeCdpBinary(exePath, appBundlePath, info, { dryRun = false } = {}) {
  const origPath = exePath ? `${exePath}.orig` : '';
  if (!exePath || !fs.existsSync(origPath)) return { restored: false };

  const needsResign = platformOf(info) === 'darwin';
  if (dryRun) {
    return { restored: false, dryRun: true, exePath, appBundlePath, needsResign };
  }

  atomicCopy(origPath, exePath, { mode: 0o755, platformInfo: info });
  fs.rmSync(origPath, { force: true });
  if (needsResign) signBinaryAdhoc(exePath);

  return { restored: true, exePath, appBundlePath, needsResign };
}

function systemApplicationsDir(info) {
  return info?.applicationsDir || process.env.AGY_AIO_APPLICATIONS_DIR || '/Applications';
}

function cdpWrapperPaths(info) {
  return [
    path.join(systemApplicationsDir(info), CDP_WRAPPER_APP),
    path.join(homeOf(info), 'Applications', CDP_WRAPPER_APP),
  ];
}

function removeCdpWrappers(info, { dryRun = false } = {}) {
  const removed = [];
  for (const candidate of cdpWrapperPaths(info)) {
    if (!fs.existsSync(candidate)) continue;
    if (!dryRun) {
      try {
        fs.rmSync(candidate, { recursive: true, force: true });
      } catch {
        // A wrapper that cannot be removed is left in place; the native
        // launcher is already installed at this point.
        continue;
      }
    }
    removed.push(candidate);
  }
  return removed;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Report whether an Antigravity CDP launcher is configured on this platform.
 *
 * @param {{ platformInfo?: object, installations?: object }} [options]
 */
export function getCdpStatus({ platformInfo, installations } = {}) {
  const info = resolvePlatformInfo(platformInfo);
  const installs = resolveInstallations(installations);
  const platform = platformOf(info);

  if (platform === 'darwin') {
    const desktop = primaryDesktop(installs);
    const exePath = stringField(desktop, 'exePath', 'executablePath', 'path');
    const nativePatched = isNativeCdpPatched(exePath);
    const candidates = cdpWrapperPaths(info).map((candidate) => ({
      path: candidate,
      exists: fs.existsSync(candidate),
    }));
    const wrapperLaunchers = candidates.filter((entry) => entry.exists).map((entry) => entry.path);
    const mode = nativePatched ? 'native' : wrapperLaunchers.length > 0 ? 'wrapper' : 'none';
    return {
      supported: true,
      configured: nativePatched || wrapperLaunchers.length > 0,
      mode,
      nativePatched,
      wrapperConfigured: wrapperLaunchers.length > 0,
      launchers: nativePatched ? [exePath, ...wrapperLaunchers] : wrapperLaunchers,
      exePath: exePath || null,
      details: { candidates, nativePatched, exePath: exePath || null },
    };
  }

  if (platform === 'win32') {
    const result = getWindowsCdpStatus();
    return {
      ...result,
      mode: result.configured ? 'native' : 'none',
      nativePatched: false,
      wrapperConfigured: Boolean(result.configured),
    };
  }

  if (platform === 'linux') {
    const dirs = linuxAppDirs(info);
    const scanDirs = [dirs.user, path.join(homeOf(info), 'Desktop'), ...dirs.system];
    const entries = findDesktopFiles(scanDirs).map((file) => {
      const execs = desktopExecValues(readText(file));
      return { path: file, exec: execs[0] || '', cdp: execs.some(hasPortFlag) };
    });
    const launchers = entries.filter((entry) => entry.cdp).map((entry) => entry.path);
    return {
      supported: true,
      configured: launchers.length > 0,
      mode: launchers.length > 0 ? 'native' : 'none',
      nativePatched: false,
      wrapperConfigured: launchers.length > 0,
      launchers,
      details: { entries, directories: scanDirs },
    };
  }

  return {
    supported: false,
    configured: false,
    launchers: [],
    details: { reason: 'unsupported-platform', platform },
  };
}

/**
 * Create (or remove) a CDP launcher.
 *
 * `mode` is one of `native` (replace the macOS app binary with a small
 * shell-less launcher), `wrapper` (classic `Antigravity-CDP.app`) or `none`
 * (restore the original app and remove every launcher).
 *
 * @param {{ mode?: 'native'|'wrapper'|'none', dryRun?: boolean, undo?: boolean, platformInfo?: object, installations?: object, launcherBinPath?: string }} [options]
 */
export function setupCdpLauncher({ mode, dryRun = false, undo = false, platformInfo, installations, launcherBinPath } = {}) {
  const info = resolvePlatformInfo(platformInfo);
  const installs = resolveInstallations(installations);
  const platform = platformOf(info);
  const selectedMode = mode === undefined || mode === null ? (undo ? 'none' : 'wrapper') : mode;

  if (!CDP_MODES.includes(selectedMode)) {
    throw new TypeError(
      `Unsupported CDP mode "${selectedMode}". Expected one of: ${CDP_MODES.join(', ')}.`,
    );
  }

  const undoMode = undo || selectedMode === 'none';

  if (platform === 'darwin') {
    const desktop = primaryDesktop(installs);
    const exePath = stringField(desktop, 'exePath', 'executablePath', 'path');
    const appBundlePath = macAppBundle(installs);

    if (undoMode) {
      const restoredNative = restoreNativeCdpBinary(exePath, appBundlePath, info, { dryRun });
      const removed = removeCdpWrappers(info, { dryRun });
      return {
        supported: true,
        configured: false,
        mode: 'none',
        undone: true,
        restoredNative,
        removed,
        needsResign: Boolean(restoredNative?.needsResign),
        appBundlePath: restoredNative?.appBundlePath || appBundlePath || null,
        ...(dryRun ? { dryRun: true } : {}),
      };
    }

    if (selectedMode === 'native') {
      if (!exePath || !fs.existsSync(exePath)) {
        return {
          supported: true,
          configured: false,
          mode: 'native',
          skipped: true,
          reason: 'antigravity-not-found',
        };
      }

      let resolvedLauncher = launcherBinPath || getCdpLauncherPaths(info).binPath;
      if (!resolvedLauncher && !dryRun) {
        buildCdpLauncher({ universal: true, platformInfo: info });
        resolvedLauncher = getCdpLauncherPaths(info).binPath;
      }
      const origPath = `${exePath}.orig`;

      if (dryRun) {
        return {
          supported: true,
          configured: false,
          dryRun: true,
          mode: 'native',
          exePath,
          origPath,
          appBundlePath,
          needsResign: Boolean(appBundlePath),
        };
      }

      if (!resolvedLauncher || !fs.existsSync(resolvedLauncher)) {
        return {
          supported: true,
          configured: false,
          mode: 'native',
          skipped: true,
          reason: 'launcher-not-found',
        };
      }

      try {
        if (!fs.existsSync(origPath) || !hasCdpLauncherMarker(exePath)) {
          atomicCopy(exePath, origPath, { mode: 0o755, platformInfo: info });
          signBinaryAdhoc(origPath);
        }
        atomicCopy(resolvedLauncher, exePath, { mode: 0o755, platformInfo: info });
        signBinaryAdhoc(exePath);
      } catch (err) {
        if (isPermissionFailure(err)) {
          throw permissionFailure('install the native CDP launcher at', exePath, err);
        }
        throw err;
      }

      removeCdpWrappers(info);

      return {
        supported: true,
        configured: true,
        mode: 'native',
        exePath,
        origPath,
        appBundlePath,
        launchers: [exePath],
        needsResign: Boolean(appBundlePath),
      };
    }

    // mode === 'wrapper': restore the original binary first so switching from
    // native leaves a clean Antigravity.app behind.
    const restored = isNativeCdpPatched(exePath)
      ? restoreNativeCdpBinary(exePath, appBundlePath, info, { dryRun })
      : null;

    const sysApps = systemApplicationsDir(info);
    const applicationTarget = path.join(sysApps, CDP_WRAPPER_APP);
    const userTarget = path.join(homeOf(info), 'Applications', CDP_WRAPPER_APP);
    let target = applicationTarget;
    if (!isRoot(info)) {
      let writable = false;
      try {
        fs.accessSync(sysApps, fs.constants.W_OK);
        writable = true;
      } catch {
        writable = false;
      }
      if (!writable) target = userTarget;
    }

    const openTarget = appBundlePath ? quoteShell(appBundlePath) : 'Antigravity';
    const shellCommand = `open -a ${openTarget} --args ${CDP_FLAGS.join(' ')}`;
    const script = `do shell script ${JSON.stringify(shellCommand)}`;
    const wrapperFields = {
      mode: 'wrapper',
      needsResign: Boolean(restored?.needsResign),
      appBundlePath: restored?.appBundlePath || null,
    };

    if (dryRun) {
      return {
        supported: true,
        configured: false,
        dryRun: true,
        targetPath: target,
        script,
        appPath: target,
        ...wrapperFields,
      };
    }

    try {
      ensureDir(path.dirname(target));
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
      execFileSync('osacompile', ['-o', target, '-e', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      if (isPermissionFailure(err)) throw permissionFailure('create the CDP launcher at', target, err);
      throw err;
    }

    chownIfPossible(target, info);
    return {
      supported: true,
      configured: true,
      targetPath: target,
      appPath: target,
      launchers: [target],
      ...wrapperFields,
    };
  }

  if (platform === 'win32') {
    const scriptPath = path.join(REPO_ROOT, 'modules', 'capsule', 'scripts', 'enable-cdp.ps1');
    if (!fs.existsSync(scriptPath)) {
      return { supported: true, skipped: true, reason: 'script-not-found', scriptPath, mode: selectedMode };
    }
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
    if (undoMode) args.push('-Undo');
    if (dryRun) {
      return {
        supported: true,
        configured: !undoMode,
        dryRun: true,
        scriptPath,
        args,
        mode: undoMode ? 'none' : selectedMode,
      };
    }

    let stdout = '';
    try {
      stdout = String(
        execFileSync('powershell.exe', args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        }) || '',
      );
    } catch (err) {
      if (isPermissionFailure(err)) {
        throw permissionFailure(`${undoMode ? 'remove' : 'enable'} CDP shortcuts via`, scriptPath, err);
      }
      const detail = [err?.stderr, err?.stdout]
        .filter((part) => part !== undefined && part !== null && part !== '')
        .map((part) => String(part).trim())
        .filter(Boolean)
        .join('\n');
      throw new Error(`Failed to run ${scriptPath}${detail ? `:\n${detail}` : '.'}`);
    }

    return {
      supported: true,
      configured: !undoMode,
      changed: true,
      scriptPath,
      stdout: stdout.trim(),
      mode: undoMode ? 'none' : selectedMode,
    };
  }

  if (platform === 'linux') {
    const dirs = linuxAppDirs(info);
    const userFiles = findDesktopFiles([dirs.user]);
    const systemFiles = findDesktopFiles(dirs.system);

    if (undoMode) {
      if (userFiles.length === 0) {
        return {
          supported: true,
          configured: false,
          changed: false,
          mode: 'none',
          ...(systemFiles.length > 0 ? { skipped: true, reason: 'system-desktop-unchanged' } : {}),
          desktopFile: systemFiles[0] || null,
        };
      }

      const updated = [];
      for (const file of userFiles) {
        const original = readText(file);
        if (original === null) continue;
        const next = updateDesktopContent(original, { undo: true });
        if (!next.changed) continue;
        if (!dryRun) {
          const fileMode = fs.statSync(file).mode & 0o777;
          writeFileAtomic(file, next.content, { mode: fileMode, platformInfo: info });
        }
        updated.push(file);
      }
      return {
        supported: true,
        configured: false,
        mode: 'none',
        changed: updated.length > 0,
        undone: true,
        updated,
        desktopFile: updated[0] || userFiles[0],
        ...(dryRun ? { dryRun: true } : {}),
      };
    }

    const source = userFiles[0] || systemFiles[0] || '';
    const target = source ? path.join(dirs.user, path.basename(source)) : path.join(dirs.user, 'antigravity.desktop');

    if (!source) {
      const exe = linuxExecutable(installs, info);
      if (!exe) {
        return {
          supported: true,
          configured: false,
          changed: false,
          skipped: true,
          reason: 'antigravity-not-found',
          mode: selectedMode,
        };
      }
      const content =
        '[Desktop Entry]\n' +
        'Type=Application\n' +
        'Name=Antigravity\n' +
        'Comment=Antigravity with local CDP enabled\n' +
        `Exec=${quoteDesktopExec(exe)} ${CDP_FLAGS.join(' ')} %U\n` +
        'Terminal=false\n' +
        'Categories=Development;\n';
      if (dryRun) {
        return { supported: true, configured: false, dryRun: true, desktopFile: target, content, mode: selectedMode };
      }
      try {
        ensureDir(dirs.user);
        writeFileAtomic(target, content, { mode: 0o644, platformInfo: info });
      } catch (err) {
        if (isPermissionFailure(err)) throw permissionFailure('write the desktop file', target, err);
        throw err;
      }
      return {
        supported: true,
        configured: true,
        changed: true,
        created: true,
        desktopFile: target,
        mode: selectedMode,
      };
    }

    const original = readText(source);
    if (original === null) {
      return {
        supported: true,
        configured: false,
        changed: false,
        skipped: true,
        reason: 'desktop-unreadable',
        desktopFile: source,
        mode: selectedMode,
      };
    }

    const next = updateDesktopContent(original, { undo: false });
    if (dryRun) {
      return {
        supported: true,
        configured: false,
        dryRun: true,
        desktopFile: target,
        content: next.content,
        mode: selectedMode,
      };
    }

    try {
      ensureDir(dirs.user);
      if (target !== source) {
        writeFileAtomic(target, next.content, {
          mode: fs.statSync(source).mode & 0o777,
          platformInfo: info,
        });
      } else if (next.changed) {
        writeFileAtomic(target, next.content, {
          mode: fs.statSync(source).mode & 0o777,
          platformInfo: info,
        });
      }
    } catch (err) {
      if (isPermissionFailure(err)) throw permissionFailure('write the desktop file', target, err);
      throw err;
    }

    return {
      supported: true,
      configured: true,
      changed: next.changed || target !== source,
      copied: target !== source,
      desktopFile: target,
      mode: selectedMode,
    };
  }

  return { supported: false, skipped: true, reason: 'unsupported-platform', platform };
}

function quoteShell(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Launch Antigravity with the CDP flags.
 *
 * @param {{ dryRun?: boolean, platformInfo?: object, installations?: object }} [options]
 */
export function launchAntigravity({ dryRun = false, platformInfo, installations } = {}) {
  const info = resolvePlatformInfo(platformInfo);
  const installs = resolveInstallations(installations);
  const platform = platformOf(info);

  if (platform === 'darwin') {
    const appBundle = macAppBundle(installs) || 'Antigravity';
    const args = ['-a', appBundle, '--args', ...CDP_FLAGS];
    if (dryRun) return { supported: true, launched: false, dryRun: true, command: 'open', args };
    const pid = spawnDetached('open', args);
    return { supported: true, launched: pid !== null, pid, command: 'open', args };
  }

  if (platform === 'win32') {
    const desktop = primaryDesktop(installs);
    const exe = stringField(desktop, 'exePath', 'executablePath', 'path');
    if (!exe) {
      return { supported: true, launched: false, reason: 'antigravity-not-found' };
    }
    if (dryRun) {
      return { supported: true, launched: false, dryRun: true, command: exe, args: [...CDP_FLAGS] };
    }
    const pid = spawnDetached(exe, [...CDP_FLAGS], { windowsHide: false });
    return { supported: true, launched: pid !== null, pid, command: exe, args: [...CDP_FLAGS] };
  }

  if (platform === 'linux') {
    const exe = linuxExecutable(installs, info);
    if (!exe) {
      return { supported: true, launched: false, reason: 'antigravity-not-found' };
    }
    if (dryRun) {
      return { supported: true, launched: false, dryRun: true, command: exe, args: [...CDP_FLAGS] };
    }
    const pid = spawnDetached(exe, [...CDP_FLAGS]);
    return { supported: true, launched: pid !== null, pid, command: exe, args: [...CDP_FLAGS] };
  }

  return { supported: false, launched: false, reason: 'unsupported-platform', platform };
}
