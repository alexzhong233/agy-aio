// Cross-platform discovery and filesystem helpers. Node built-ins only.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isSafeUserName(user) {
  return typeof user === 'string' && /^[A-Za-z0-9_.][A-Za-z0-9._-]*$/.test(user);
}

function readPasswdEntry(user) {
  if (!isSafeUserName(user)) return null;
  try {
    const content = fs.readFileSync('/etc/passwd', 'utf8');
    for (const line of content.split('\n')) {
      const fields = line.split(':');
      if (fields[0] !== user) continue;
      const uid = Number.parseInt(fields[2], 10);
      const gid = Number.parseInt(fields[3], 10);
      return {
        uid: Number.isInteger(uid) ? uid : null,
        gid: Number.isInteger(gid) ? gid : null,
        home: fields[5] || null
      };
    }
  } catch {
    // /etc/passwd is unavailable on some platforms (Windows) or unreadable.
  }
  return null;
}

function parseEnvId(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function lookupUid(user) {
  if (!isSafeUserName(user)) return null;
  try {
    const output = execFileSync('id', ['-u', user], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const uid = Number.parseInt(output, 10);
    if (Number.isInteger(uid)) return uid;
  } catch {
    // Fall through to a direct passwd lookup.
  }
  const entry = readPasswdEntry(user);
  return entry && entry.uid != null ? entry.uid : null;
}

function lookupGid(user) {
  if (!isSafeUserName(user)) return null;
  try {
    const output = execFileSync('id', ['-g', user], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const gid = Number.parseInt(output, 10);
    if (Number.isInteger(gid)) return gid;
  } catch {
    // Fall through to a direct passwd lookup.
  }
  const entry = readPasswdEntry(user);
  return entry && entry.gid != null ? entry.gid : null;
}

function resolveUserHome(user, platform) {
  if (!isSafeUserName(user)) return os.homedir();

  if (platform === 'darwin') {
    try {
      const output = execFileSync('dscl', ['.', '-read', `/Users/${user}`, 'NFSHomeDirectory'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const match = /NFSHomeDirectory:\s*(.+)/.exec(output);
      if (match && match[1].trim()) return match[1].trim();
    } catch {
      // dscl may not be available or the user may not exist.
    }
  }

  if (platform === 'linux') {
    try {
      const output = execFileSync('getent', ['passwd', user], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      const fields = output.split(':');
      if (fields[5]) return fields[5];
    } catch {
      // getent is not always installed.
    }
  }

  const entry = readPasswdEntry(user);
  if (entry && entry.home) return entry.home;

  return platform === 'darwin' ? `/Users/${user}` : `/home/${user}`;
}

export function getPlatformInfo({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
  const isRoot = typeof process.getuid === 'function' ? process.getuid() === 0 : false;
  const sudoUser = env && env.SUDO_USER;
  const underSudo = isRoot && platform !== 'win32' && isSafeUserName(sudoUser);

  const realUser = underSudo ? sudoUser : null;
  const realUid = underSudo ? (lookupUid(sudoUser) ?? parseEnvId(env.SUDO_UID)) : null;
  const realGid = underSudo ? (lookupGid(sudoUser) ?? parseEnvId(env.SUDO_GID)) : null;
  const realUserHome = underSudo ? resolveUserHome(sudoUser, platform) : os.homedir();

  return {
    os: platform,
    arch,
    isRoot,
    realUser,
    realUserHome,
    realUid,
    realGid,
    dataDir: path.join(realUserHome, '.agy-aio')
  };
}

function dedupeCandidates(candidates, platform) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    const key = platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function existingLanguageServers(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function makeEntry(kind, name, rootDir, fields = {}) {
  return {
    kind,
    name,
    rootDir,
    exePath: null,
    resourcesDir: null,
    asarPath: null,
    backupAsarPath: null,
    languageServers: [],
    cliBinPath: null,
    appBundlePath: null,
    ...fields
  };
}

function buildMacDesktop(candidate) {
  const bundle = candidate;
  const resourcesDir = path.join(bundle, 'Contents', 'Resources');
  const asarPath = path.join(resourcesDir, 'app.asar');
  const primaryLanguageServer = path.join(resourcesDir, 'bin', 'language_server');
  const languageServers = existingLanguageServers([
    primaryLanguageServer,
    `${primaryLanguageServer}.orig`
  ]);
  const bundleExists = candidate.endsWith('.app') && fs.existsSync(candidate);
  const asarExists = fs.existsSync(asarPath);

  if (!bundleExists && !asarExists && languageServers.length === 0) return null;

  return makeEntry('desktop', 'Antigravity Desktop', bundle, {
    exePath: path.join(bundle, 'Contents', 'MacOS', 'Antigravity'),
    resourcesDir,
    asarPath,
    backupAsarPath: `${asarPath}.bak`,
    languageServers,
    appBundlePath: bundle
  });
}

function buildMacIde(candidate) {
  const resourcesDir = path.join(candidate, 'Contents', 'Resources');
  const asarPath = path.join(resourcesDir, 'app.asar');
  const packageJsonPath = path.join(resourcesDir, 'app', 'package.json');
  const binDir = path.join(resourcesDir, 'app', 'extensions', 'antigravity', 'bin');
  const languageServers = existingLanguageServers([
    path.join(binDir, 'language_server_macos_arm'),
    path.join(binDir, 'language_server_macos_x64')
  ]);
  const bundleExists = candidate.endsWith('.app') && fs.existsSync(candidate);

  if (!bundleExists && !fs.existsSync(asarPath) && !fs.existsSync(packageJsonPath) && languageServers.length === 0) {
    return null;
  }

  return makeEntry('ide', 'Antigravity IDE', candidate, {
    exePath: path.join(candidate, 'Contents', 'MacOS', 'Antigravity IDE'),
    resourcesDir,
    asarPath,
    backupAsarPath: `${asarPath}.bak`,
    languageServers,
    appBundlePath: candidate
  });
}

function buildWindowsDesktop(candidate) {
  const exePath = path.join(candidate, 'Antigravity.exe');
  const resourcesDir = path.join(candidate, 'resources');
  const asarPath = path.join(resourcesDir, 'app.asar');
  const languageServers = existingLanguageServers([
    path.join(resourcesDir, 'bin', 'language_server.exe'),
    path.join(resourcesDir, 'app', 'extensions', 'antigravity', 'bin', 'language_server_windows_x64.exe')
  ]);

  if (!fs.existsSync(exePath) && !fs.existsSync(asarPath) && languageServers.length === 0) return null;

  return makeEntry('desktop', 'Antigravity Desktop', candidate, {
    exePath,
    resourcesDir,
    asarPath,
    backupAsarPath: `${asarPath}.bak`,
    languageServers
  });
}

function buildWindowsIde(candidate) {
  const exePath = path.join(candidate, 'Antigravity IDE.exe');
  const resourcesDir = path.join(candidate, 'resources');
  const asarPath = path.join(resourcesDir, 'app.asar');
  const packageJsonPath = path.join(resourcesDir, 'app', 'package.json');
  const languageServers = existingLanguageServers([
    path.join(resourcesDir, 'app', 'extensions', 'antigravity', 'bin', 'language_server_windows_x64.exe')
  ]);

  if (!fs.existsSync(exePath) && !fs.existsSync(packageJsonPath) && languageServers.length === 0) return null;

  return makeEntry('ide', 'Antigravity IDE', candidate, {
    exePath,
    resourcesDir,
    asarPath,
    backupAsarPath: `${asarPath}.bak`,
    languageServers
  });
}

function buildLinuxDesktop(candidate) {
  const resourcesDir = path.join(candidate, 'resources');
  const asarPath = path.join(resourcesDir, 'app.asar');
  const languageServers = existingLanguageServers([
    path.join(resourcesDir, 'bin', 'language_server'),
    path.join(resourcesDir, 'app', 'extensions', 'antigravity', 'bin', 'language_server_linux_x64'),
    path.join(resourcesDir, 'app', 'extensions', 'antigravity', 'bin', 'language_server_linux_arm64')
  ]);
  const exePath = [path.join(candidate, 'antigravity'), path.join(candidate, 'Antigravity')].find(exe =>
    fs.existsSync(exe)
  ) || path.join(candidate, 'antigravity');

  if (!fs.existsSync(asarPath) && languageServers.length === 0 && !fs.existsSync(exePath)) return null;

  return makeEntry('desktop', 'Antigravity Desktop', candidate, {
    exePath,
    resourcesDir,
    asarPath,
    backupAsarPath: `${asarPath}.bak`,
    languageServers
  });
}

function buildCliEntry(candidate, name = 'Antigravity CLI') {
  if (!fs.existsSync(candidate)) return null;
  const resolved = path.resolve(candidate);
  return makeEntry('cli', name, path.dirname(resolved), {
    exePath: resolved,
    cliBinPath: resolved
  });
}

function whereAgy() {
  try {
    const output = execFileSync('where.exe', ['agy'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return output
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function detectInstallations({ appDir = '', platformInfo, env = process.env } = {}) {
  const info = platformInfo || getPlatformInfo({ env });
  const platform = info.os;
  const home = info.realUserHome || os.homedir();
  const desktop = [];
  const ide = [];
  const cli = [];

  if (platform === 'darwin') {
    const desktopCandidates = [];
    if (appDir) {
      const resolved = path.resolve(appDir);
      if (resolved.endsWith('.app')) {
        desktopCandidates.push(resolved);
      } else {
        const nested = path.join(resolved, 'Antigravity.app');
        if (fs.existsSync(nested)) desktopCandidates.push(nested);
        desktopCandidates.push(resolved);
      }
    }
    desktopCandidates.push('/Applications/Antigravity.app', path.join(home, 'Applications/Antigravity.app'));

    for (const candidate of dedupeCandidates(desktopCandidates, platform)) {
      const entry = buildMacDesktop(candidate);
      if (entry) desktop.push(entry);
    }

    const ideCandidates = [
      '/Applications/Antigravity IDE.app',
      path.join(home, 'Applications/Antigravity IDE.app')
    ];
    for (const candidate of dedupeCandidates(ideCandidates, platform)) {
      const entry = buildMacIde(candidate);
      if (entry) ide.push(entry);
    }

    const cliCandidates = [
      '/opt/homebrew/bin/agy',
      '/usr/local/bin/agy',
      path.join(home, '.antigravity/antigravity/bin/agy')
    ];
    for (const candidate of dedupeCandidates(cliCandidates, platform)) {
      const entry = buildCliEntry(candidate);
      if (entry) cli.push(entry);
    }
  } else if (platform === 'win32') {
    const localAppData = (env && env.LOCALAPPDATA) || path.join(home, 'AppData', 'Local');

    const desktopCandidates = [];
    if (appDir) desktopCandidates.push(appDir);
    desktopCandidates.push(
      path.join(localAppData, 'Programs', 'Antigravity'),
      path.join(localAppData, 'Programs', 'antigravity')
    );
    for (const candidate of dedupeCandidates(desktopCandidates, platform)) {
      const entry = buildWindowsDesktop(candidate);
      if (entry) desktop.push(entry);
    }

    const ideCandidates = [path.join(localAppData, 'Programs', 'Antigravity IDE')];
    for (const candidate of dedupeCandidates(ideCandidates, platform)) {
      const entry = buildWindowsIde(candidate);
      if (entry) ide.push(entry);
    }

    const cliCandidates = [path.join(localAppData, 'agy', 'bin', 'agy.exe')];
    if (env === process.env && !appDir) cliCandidates.push(...whereAgy());
    for (const candidate of dedupeCandidates(cliCandidates, platform)) {
      const entry = buildCliEntry(candidate, 'agy');
      if (entry) cli.push(entry);
    }
  } else if (platform === 'linux') {
    const desktopCandidates = [];
    if (appDir) desktopCandidates.push(appDir);
    desktopCandidates.push(
      '/opt/Antigravity',
      '/usr/share/antigravity',
      '/usr/lib/antigravity',
      path.join(home, '.local/share/Antigravity')
    );
    for (const candidate of dedupeCandidates(desktopCandidates, platform)) {
      const entry = buildLinuxDesktop(candidate);
      if (entry) desktop.push(entry);
    }

    const cliCandidates = [
      '/usr/local/bin/agy',
      path.join(home, '.local/bin/agy'),
      path.join(home, '.antigravity/antigravity/bin/agy')
    ];
    for (const candidate of dedupeCandidates(cliCandidates, platform)) {
      const entry = buildCliEntry(candidate);
      if (entry) cli.push(entry);
    }
  }

  return {
    desktop,
    ide,
    cli,
    primaryDesktop: desktop[0] || null,
    primaryIde: ide[0] || null,
    allTargets: [...desktop, ...ide, ...cli]
  };
}

export function chownToRealUser(targetPath, platformInfo) {
  if (!targetPath || !platformInfo || !platformInfo.isRoot) return false;
  if (platformInfo.realUid == null || platformInfo.realGid == null) return false;
  try {
    fs.chownSync(targetPath, platformInfo.realUid, platformInfo.realGid);
    return true;
  } catch {
    return false;
  }
}

export function atomicCopy(src, dest, { mode, platformInfo } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.agy-aio.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.copyFileSync(src, tmp);
    if (mode != null) fs.chmodSync(tmp, mode);
    chownToRealUser(tmp, platformInfo);
    fs.renameSync(tmp, dest);
  } finally {
    if (fs.existsSync(tmp)) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Best-effort cleanup; the rename may already have consumed the temp file.
      }
    }
  }
}

export function atomicWriteFile(dest, content, { mode = 0o644, platformInfo } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.agy-aio.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, content, { mode });
    fs.chmodSync(tmp, mode);
    chownToRealUser(tmp, platformInfo);
    fs.renameSync(tmp, dest);
  } finally {
    if (fs.existsSync(tmp)) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Best-effort cleanup; the rename may already have consumed the temp file.
      }
    }
  }
}

function loadProcessCheck() {
  try {
    return require('../modules/localization/process-check.js');
  } catch {
    return null;
  }
}

function listWindowsProcessNames() {
  try {
    const output = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return output
      .split(/\r?\n/)
      .map(line => {
        const match = /^"([^"]+)"/.exec(line.trim());
        return match ? match[1].toLowerCase() : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isExtraWindowsProcessRunning() {
  const names = listWindowsProcessNames();
  return names.some(name =>
    ['antigravity.exe', 'language_server.exe', 'antigravity ide.exe', 'language_server_windows_x64.exe'].includes(name)
  );
}

function isUnixProcessRunningFallback() {
  try {
    execFileSync('pgrep', ['-xi', 'antigravity|antigravity\\.orig|language_server'], {
      stdio: 'ignore',
      timeout: 5000
    });
    return true;
  } catch {
    return false;
  }
}

export function isAntigravityRunning() {
  const processCheck = loadProcessCheck();
  if (processCheck && typeof processCheck.isAppRunningStrict === 'function') {
    try {
      if (processCheck.isAppRunningStrict()) return true;
    } catch {
      // Detection can fail on restricted systems; fall through to the local checks.
    }
  }

  if (process.platform === 'win32') return isExtraWindowsProcessRunning();
  return isUnixProcessRunningFallback();
}

export async function stopAntigravityProcesses({ dryRun = false, timeoutMs = 5000 } = {}) {
  if (dryRun) return !isAntigravityRunning();

  const processCheck = loadProcessCheck();
  if (processCheck && typeof processCheck.stopAntigravityProcesses === 'function') {
    try {
      processCheck.stopAntigravityProcesses();
    } catch {
      // Continue with the targeted fallbacks below.
    }
  }

  if (process.platform === 'win32') {
    for (const imageName of ['Antigravity IDE.exe', 'language_server_windows_x64.exe']) {
      try {
        execFileSync('taskkill.exe', ['/F', '/IM', imageName], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 5000
        });
      } catch (error) {
        // 128 means the image was not running; anything else is best-effort.
        if (error && error.status !== 128) {
          // Ignore: the process may have exited between detection and termination.
        }
      }
    }
  } else {
    for (const name of ['Antigravity.orig', 'Antigravity IDE', 'language_server']) {
      try {
        execFileSync('pkill', ['-x', name], {
          stdio: 'ignore',
          timeout: 5000
        });
      } catch (error) {
        // 1 means no process matched; other failures are best-effort.
        if (error && error.status !== 1) {
          // Ignore: the process may have exited between detection and termination.
        }
      }
    }
  }

  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (isAntigravityRunning() && Date.now() < deadline) {
    await delay(150);
  }
  return !isAntigravityRunning();
}

export function isPortOpen(host, port, timeoutMs = 800) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));

    try {
      socket.connect(Number(port), host);
    } catch {
      finish(false);
    }
  });
}

function parseProxyUrl(value) {
  if (!value || typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const protocol = url.protocol.replace(':', '').toLowerCase();
    const type = protocol.startsWith('socks') ? 'socks5' : 'http';
    let port = Number.parseInt(url.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      if (type === 'socks5') port = 1080;
      else if (protocol === 'https') port = 443;
      else port = 80;
    }
    return { host: url.hostname || '127.0.0.1', port, type };
  } catch {
    return null;
  }
}

export async function detectLocalProxyPort({
  host = '127.0.0.1',
  ports = [7890, 7897, 10808, 10809, 1080, 6152, 7891, 2080],
  env = process.env
} = {}) {
  for (const key of ['ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY']) {
    const parsed = parseProxyUrl(env && env[key]);
    if (!parsed) continue;
    if (await isPortOpen(parsed.host, parsed.port)) {
      return { host: parsed.host, port: parsed.port, type: parsed.type, source: key };
    }
  }

  for (const port of ports) {
    if (await isPortOpen(host, port)) {
      return { host, port, type: 'socks5', source: 'probe' };
    }
  }

  return null;
}
