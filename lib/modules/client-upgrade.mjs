// Antigravity Desktop client update helpers: manifest parsing, updater cache
// discovery, pending-update detection and the platform-specific upgrade flow.
// Node built-ins only.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  fetchText,
  downloadFile,
  verifySha512Base64,
  extractMacZip
} from '../net.mjs';
import { checkCodesign, verifyAppSignature, isPermissionError } from '../codesign.mjs';
import { getPlatformInfo, detectInstallations, chownToRealUser } from '../platform.mjs';
import { compareVersions, normalizeVersionTag } from '../version.mjs';

export const DEFAULT_UPDATER_URL =
  'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/';
export const DEFAULT_UPDATER_CACHE_DIR_NAME = 'com.google.antigravity';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

// --- small shared helpers -------------------------------------------------

function removeFile(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best-effort cleanup.
  }
}

function readOs(platformInfo) {
  return platformInfo?.os || process.platform;
}

function readHome(platformInfo, env) {
  return platformInfo?.realUserHome || (env && env.HOME) || os.homedir();
}

function coerceYamlValue(raw, key = '') {
  const value = String(raw ?? '').trim();
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === "'" || quote === '"') && value[value.length - 1] === quote) {
      return value.slice(1, -1);
    }
  }
  if (value !== '' && /^-?\d+(?:\.\d+)?$/.test(value)) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  // electron-builder occasionally emits a numeric string for "size".
  if (key === 'size' && value !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return value;
}

function readJsonVersion(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return String(parsed?.version ?? '').trim() || null;
  } catch {
    return null;
  }
}

function readPlistVersion(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(text);
    return match ? match[1].trim() || null : null;
  } catch {
    return null;
  }
}

function resolveInstallation({ appDir, platformInfo, installations, env }) {
  const info = platformInfo || getPlatformInfo({ env });
  const installs = installations || detectInstallations({ appDir, platformInfo: info, env });
  return { info, installs, desktop: installs.primaryDesktop };
}

/**
 * Only https URLs, or http on an explicit loopback host, may be used to fetch
 * update metadata or payloads. This keeps local test servers usable without
 * allowing plaintext traffic to arbitrary hosts.
 */
export function isAllowedUpdateUrl(urlStr) {
  let url;
  try {
    url = new URL(String(urlStr ?? '').trim());
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  return LOOPBACK_HOSTS.has(url.hostname.replace(/^\[|\]$/g, '').toLowerCase());
}

// 1. Manifest / config parsing ---------------------------------------------

/**
 * Parse the small subset of YAML used by electron-builder "latest-*.yml"
 * manifests and app-update.yml files. No external dependencies.
 *
 * @param {string} text
 * @returns {{ files: Array<Record<string, unknown>>, [key: string]: unknown }}
 */
export function parseSimpleYaml(text) {
  const topLevel = {};
  const files = [];
  let currentFile = null;
  let inFiles = false;

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const indent = rawLine.length - rawLine.trimStart().length;

    if (indent === 0 && /^files\s*:/.test(line)) {
      inFiles = true;
      continue;
    }
    if (indent === 0 && /^[^:]+:/.test(line)) {
      inFiles = false;
    }

    const itemMatch = inFiles ? /^-\s+([^:]+)\s*:\s*(.*)$/.exec(line) : null;
    if (itemMatch) {
      currentFile = {};
      files.push(currentFile);
      currentFile[itemMatch[1].trim()] = coerceYamlValue(itemMatch[2], itemMatch[1].trim());
      continue;
    }

    const fieldMatch = /^([^:]+)\s*:\s*(.*)$/.exec(line);
    if (!fieldMatch) continue;
    const key = fieldMatch[1].trim();
    if (!key) continue;

    if (inFiles && currentFile) {
      currentFile[key] = coerceYamlValue(fieldMatch[2], key);
    } else if (!inFiles) {
      topLevel[key] = coerceYamlValue(fieldMatch[2], key);
    }
  }

  return { ...topLevel, files };
}

/**
 * Map a platform to the electron-builder manifest file name.
 */
export function getManifestFileName(platformInfo) {
  const osName = readOs(platformInfo);
  const arch = platformInfo?.arch || process.arch;
  if (osName === 'darwin') return `latest-${arch}-mac.yml`;
  if (osName === 'win32') return `latest-${arch}-win.yml`;
  if (osName === 'linux') return `latest-${arch}-linux.yml`;
  return null;
}

/**
 * Read app-update.yml next to the installed desktop app, falling back to the
 * built-in updater defaults. The returned URL always ends with a slash so a
 * manifest file name can be appended directly.
 */
export function readAppUpdateConfig(desktopEntry, platformInfo) {
  const osName = readOs(platformInfo);
  const base = osName === 'darwin'
    ? desktopEntry?.appBundlePath || ''
    : desktopEntry?.rootDir || '';
  const ymlPath = osName === 'darwin'
    ? path.join(base, 'Contents', 'Resources', 'app-update.yml')
    : path.join(base, 'resources', 'app-update.yml');

  let parsed = null;
  try {
    parsed = parseSimpleYaml(fs.readFileSync(ymlPath, 'utf8'));
  } catch {
    parsed = null;
  }

  const rawUrl = typeof parsed?.url === 'string' && parsed.url.trim()
    ? parsed.url.trim()
    : DEFAULT_UPDATER_URL;
  const url = rawUrl.endsWith('/') ? rawUrl : `${rawUrl}/`;
  const updaterCacheDirName = typeof parsed?.updaterCacheDirName === 'string' && parsed.updaterCacheDirName.trim()
    ? parsed.updaterCacheDirName.trim()
    : DEFAULT_UPDATER_CACHE_DIR_NAME;

  return {
    url,
    updaterCacheDirName,
    provider: parsed?.provider ?? null,
    path: ymlPath,
    fromFile: Boolean(parsed)
  };
}

/**
 * Resolve the Squirrel/Electron updater cache layout for the current platform.
 */
export function getUpdaterCachePaths(
  platformInfo,
  cacheDirName = DEFAULT_UPDATER_CACHE_DIR_NAME,
  env = process.env
) {
  const osName = readOs(platformInfo);
  const home = readHome(platformInfo, env);
  const dirName =
    path.basename(String(cacheDirName || DEFAULT_UPDATER_CACHE_DIR_NAME).trim()) ||
    DEFAULT_UPDATER_CACHE_DIR_NAME;

  let cacheDir;
  let shipItDir;

  if (env?.AGY_AIO_UPDATER_CACHE_DIR) {
    cacheDir = path.resolve(env.AGY_AIO_UPDATER_CACHE_DIR);
    shipItDir = `${cacheDir}.ShipIt`;
  } else if (osName === 'darwin') {
    cacheDir = path.join(home, 'Library', 'Caches', dirName);
    shipItDir = path.join(home, 'Library', 'Caches', `${dirName}.ShipIt`);
  } else if (osName === 'win32') {
    const localAppData = (env && env.LOCALAPPDATA) || path.join(home, 'AppData', 'Local');
    cacheDir = path.join(localAppData, `${dirName}-updater`);
    shipItDir = null;
  } else if (osName === 'linux') {
    const cacheHome = (env && env.XDG_CACHE_HOME) || path.join(home, '.cache');
    cacheDir = path.join(cacheHome, `${dirName}-updater`);
    shipItDir = null;
  } else {
    cacheDir = path.join(home, '.cache', `${dirName}-updater`);
    shipItDir = null;
  }

  return {
    cacheDir,
    pendingDir: path.join(cacheDir, 'pending'),
    updateInfoPath: path.join(cacheDir, 'pending', 'update-info.json'),
    updateZipPath: path.join(cacheDir, 'update.zip'),
    shipItDir
  };
}

/**
 * Inspect update-info.json and the staged package inside the updater's
 * pending directory. A corrupt/missing metadata file cleanly reports no
 * pending update.
 */
export function getPendingUpdate({ appDir = '', platformInfo, installations, env = process.env } = {}) {
  const { info, desktop } = resolveInstallation({ appDir, platformInfo, installations, env });
  const appUpdate = readAppUpdateConfig(desktop, info);
  const { updateInfoPath, pendingDir } = getUpdaterCachePaths(info, appUpdate.updaterCacheDirName, env);

  const missing = {
    exists: false,
    fileName: null,
    filePath: null,
    sha512: null,
    size: 0,
    updateInfoPath
  };

  let updateInfo;
  try {
    updateInfo = JSON.parse(fs.readFileSync(updateInfoPath, 'utf8'));
  } catch {
    return missing;
  }
  if (!updateInfo || typeof updateInfo !== 'object') return missing;

  const fileName = path.basename(String(updateInfo.fileName || '').trim());
  if (!fileName || fileName === '.' || fileName === '..') return missing;

  const filePath = path.join(pendingDir, fileName);
  let stat = null;
  try {
    const candidate = fs.statSync(filePath);
    if (candidate.isFile()) stat = candidate;
  } catch {
    // No staged file yet.
  }

  return {
    exists: Boolean(stat),
    fileName,
    filePath,
    sha512: updateInfo.sha512 || null,
    size: stat ? stat.size : 0,
    updateInfoPath
  };
}

/**
 * Read the installed client version from Info.plist (macOS) or from the
 * packaged product.json / package.json, in that order.
 */
export function readClientVersion(desktopEntry, platformInfo) {
  const osName = readOs(platformInfo);
  const candidates = [];

  if (osName === 'darwin') {
    const bundle = desktopEntry?.appBundlePath || '';
    candidates.push(
      { plist: path.join(bundle, 'Contents', 'Info.plist') },
      { json: path.join(bundle, 'Contents', 'Resources', 'app', 'product.json') },
      { json: path.join(bundle, 'Contents', 'Resources', 'app', 'package.json') }
    );
  } else {
    const root = desktopEntry?.rootDir || '';
    candidates.push(
      { json: path.join(root, 'resources', 'app', 'product.json') },
      { json: path.join(root, 'resources', 'app', 'package.json') }
    );
  }

  for (const candidate of candidates) {
    const version = candidate.plist
      ? readPlistVersion(candidate.plist)
      : readJsonVersion(candidate.json);
    if (version) return version;
  }
  return null;
}

// 2. Remote manifest -------------------------------------------------------

function selectManifestFile(parsed, osName) {
  const files = Array.isArray(parsed.files) ? parsed.files : [];
  const urlOf = entry => String(entry?.url || '').trim().toLowerCase();
  const find = suffix => files.find(entry => urlOf(entry).endsWith(suffix));

  if (osName === 'darwin') return find('.zip') || files[0] || null;
  if (osName === 'win32') return find('.exe') || files[0] || null;
  if (osName === 'linux') return find('.appimage') || find('.deb') || files[0] || null;
  return files[0] || null;
}

/**
 * Fetch and parse the electron-builder latest manifest for this platform.
 */
export async function fetchClientManifest({
  appDir = '',
  platformInfo,
  installations,
  env = process.env,
  fetchImpl = fetch
} = {}) {
  const { info, desktop } = resolveInstallation({ appDir, platformInfo, installations, env });
  const appUpdate = readAppUpdateConfig(desktop, info);
  const fileName = getManifestFileName(info);
  if (!fileName) throw new Error(`No updater manifest is defined for platform "${info.os}"`);

  const manifestUrl = new URL(fileName, appUpdate.url).toString();
  if (!isAllowedUpdateUrl(manifestUrl)) {
    throw new Error(`Unsafe update manifest URL: ${manifestUrl}`);
  }

  const parsed = parseSimpleYaml(await fetchText(manifestUrl, { env, fetchImpl }));
  const selected = selectManifestFile(parsed, info.os);

  let downloadUrl = null;
  if (selected?.url) {
    downloadUrl = new URL(String(selected.url), manifestUrl).toString();
  } else if (parsed.path) {
    downloadUrl = new URL(String(parsed.path), manifestUrl).toString();
  }
  if (!downloadUrl) {
    throw new Error(`Manifest ${manifestUrl} does not contain a download URL`);
  }
  if (!isAllowedUpdateUrl(downloadUrl)) {
    throw new Error(`Unsafe update download URL: ${downloadUrl}`);
  }

  return {
    manifestUrl,
    version: parsed.version ? String(parsed.version).trim() : null,
    downloadUrl,
    fileName: path.basename(new URL(downloadUrl).pathname),
    sha512: selected?.sha512 || parsed.sha512 || null,
    size: selected?.size || null,
    files: parsed.files
  };
}

/**
 * Report the installed version, signature state, pending package, and
 * optionally the remote update status. Remote failures never hide local
 * information: they surface in `remoteError`.
 */
export async function getClientUpdateStatus({
  appDir = '',
  platformInfo,
  installations,
  env = process.env,
  checkRemote = false,
  fetchImpl = fetch
} = {}) {
  const { info, installs, desktop } = resolveInstallation({ appDir, platformInfo, installations, env });
  const clientVersion = readClientVersion(desktop, info);
  const appCodesign = info.os === 'darwin' ? checkCodesign(desktop?.appBundlePath) : 'not-applicable';
  const autoUpdateBlocked =
    info.os === 'darwin' && Boolean(desktop?.appBundlePath) && appCodesign !== 'google';
  const pendingUpdate = getPendingUpdate({ appDir, platformInfo: info, installations: installs, env });
  const appUpdateConfig = readAppUpdateConfig(desktop, info);

  const status = {
    os: info.os,
    clientVersion,
    appCodesign,
    autoUpdateBlocked,
    updaterUrl: appUpdateConfig.url,
    appUpdateConfig,
    pendingUpdate,
    pendingAvailable: Boolean(pendingUpdate.exists),
    manifestUrl: null,
    latestVersion: null,
    downloadUrl: null,
    expectedSha512: null,
    expectedSize: null,
    updateAvailable: null,
    pendingMatchesLatest: false,
    remoteError: null
  };

  if (!checkRemote || !getManifestFileName(info)) return status;

  try {
    const manifest = await fetchClientManifest({
      appDir,
      platformInfo: info,
      installations: installs,
      env,
      fetchImpl
    });
    const cmp = compareVersions(clientVersion, manifest.version);
    status.manifestUrl = manifest.manifestUrl;
    status.latestVersion = manifest.version;
    status.downloadUrl = manifest.downloadUrl;
    status.expectedSha512 = manifest.sha512;
    status.expectedSize = manifest.size;
    status.updateAvailable = cmp === null ? null : cmp < 0;
    status.pendingMatchesLatest = Boolean(
      pendingUpdate.exists && manifest.sha512 && pendingUpdate.sha512 === manifest.sha512
    );
  } catch (error) {
    status.remoteError = error instanceof Error ? error.message : String(error);
  }

  return status;
}

// 3. Upgrade execution -----------------------------------------------------

function cleanStaleUpdateCache(cachePaths) {
  const cleaned = [];
  const candidates = [
    path.join(cachePaths.pendingDir, 'Antigravity.zip'),
    cachePaths.updateInfoPath,
    cachePaths.updateZipPath
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        fs.rmSync(candidate, { recursive: true, force: true });
        cleaned.push(candidate);
      }
    } catch {
      // Best-effort cleanup.
    }
  }

  if (cachePaths.shipItDir) {
    try {
      for (const entry of fs.readdirSync(cachePaths.shipItDir)) {
        const target = path.join(cachePaths.shipItDir, entry);
        try {
          fs.rmSync(target, { recursive: true, force: true });
          cleaned.push(target);
        } catch {
          // Best-effort cleanup.
        }
      }
    } catch {
      // The ShipIt directory may not exist.
    }
  }

  return cleaned;
}

function findStagedApp(stageDir) {
  const preferred = path.join(stageDir, 'Antigravity.app');
  if (fs.existsSync(preferred)) return preferred;

  let entries = [];
  try {
    entries = fs.readdirSync(stageDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const apps = entries
    .filter(entry => entry.isDirectory() && entry.name.endsWith('.app'))
    .map(entry => path.join(stageDir, entry.name));
  return apps.length === 1 ? apps[0] : null;
}

function assertStagedApp(stagedApp) {
  if (!stagedApp) {
    throw new Error('The extracted package does not contain an Antigravity.app bundle.');
  }
  const exePath = path.join(stagedApp, 'Contents', 'MacOS', 'Antigravity');
  const plistPath = path.join(stagedApp, 'Contents', 'Info.plist');
  if (!fs.existsSync(exePath) || !fs.existsSync(plistPath)) {
    throw new Error(`Extracted app bundle is incomplete: ${stagedApp}`);
  }
}

function permissionFailure(action, target, cause) {
  const error = new Error(
    `Permission denied while trying to ${action} "${target}". ` +
      'Move the app to a location you own (for example ~/Applications), ' +
      'or run with administrator rights, then try again.'
  );
  error.isPermissionError = true;
  error.code = cause?.code;
  error.cause = cause;
  return error;
}

function swapAppBundle(stagedApp, appBundlePath) {
  const rollbackPath = path.join(
    path.dirname(appBundlePath),
    `.${path.basename(appBundlePath)}.old-${process.pid}-${Date.now()}`
  );

  try {
    fs.renameSync(appBundlePath, rollbackPath);
    try {
      // Both paths live on the same filesystem, so this rename is atomic.
      fs.renameSync(stagedApp, appBundlePath);
    } catch (error) {
      try {
        fs.renameSync(rollbackPath, appBundlePath);
      } catch {
        // Best-effort rollback; surface the original swap failure.
      }
      throw error;
    }
    fs.rmSync(rollbackPath, { recursive: true, force: true });
  } catch (error) {
    if (isPermissionError(error)) throw permissionFailure('replace', appBundlePath, error);
    throw error;
  }
}

function clearQuarantine(appBundlePath) {
  try {
    execFileSync('xattr', ['-cr', appBundlePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
  } catch (error) {
    // xattr exits non-zero when there is nothing to remove; only permission
    // failures are worth surfacing after a successful swap.
    if (isPermissionError(error)) {
      throw permissionFailure('clear quarantine attributes on', appBundlePath, error);
    }
  }
}

async function applyMacUpgrade({
  desktop,
  packageFilePath,
  clientVersion,
  source,
  force,
  skipSignatureCheck,
  beforeSwap,
  info,
  cachePaths
}) {
  const appBundlePath = desktop.appBundlePath;
  const stageDir = path.join(
    path.dirname(appBundlePath),
    `.agy-aio-upgrade-stage-${process.pid}-${Date.now()}`
  );

  try {
    await extractMacZip(packageFilePath, stageDir);

    const stagedApp = findStagedApp(stageDir);
    assertStagedApp(stagedApp);

    const newVersion = readClientVersion({ appBundlePath: stagedApp }, info);
    const cmp = compareVersions(clientVersion, newVersion);
    if (clientVersion && newVersion && cmp !== null && cmp >= 0 && !force) {
      return { upgraded: false, alreadyLatest: true, previousVersion: clientVersion, newVersion };
    }

    if (!skipSignatureCheck) {
      const sig = verifyAppSignature(stagedApp);
      if (!sig.valid || sig.codesign !== 'google') {
        throw new Error(
          `Official Google signature check failed for "${packageFilePath}" ` +
            `(valid=${sig.valid}, codesign=${sig.codesign})${sig.detail ? `: ${sig.detail}` : ''}. ` +
            'Refusing to install an app that is not signed by Google LLC.'
        );
      }
    }

    if (typeof beforeSwap === 'function') {
      const proceed = await beforeSwap({
        previousVersion: clientVersion,
        newVersion,
        source,
        packagePath: packageFilePath,
        appBundlePath
      });
      if (proceed === false) {
        return { upgraded: false, cancelled: true, previousVersion: clientVersion, newVersion };
      }
    }

    swapAppBundle(stagedApp, appBundlePath);
    clearQuarantine(appBundlePath);
    chownToRealUser(appBundlePath, info);
    const cleanedCache = cleanStaleUpdateCache(cachePaths);

    return {
      upgraded: true,
      os: 'darwin',
      source,
      packagePath: packageFilePath,
      previousVersion: clientVersion,
      newVersion,
      appBundlePath,
      cleanedCache
    };
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

async function applyLinuxAppImageUpgrade({
  desktop,
  packageFilePath,
  clientVersion,
  newVersion,
  source,
  beforeSwap,
  info
}) {
  const targetPath = desktop.exePath;

  if (typeof beforeSwap === 'function') {
    const proceed = await beforeSwap({
      previousVersion: clientVersion,
      newVersion,
      source,
      packagePath: packageFilePath,
      targetPath
    });
    if (proceed === false) {
      return { upgraded: false, cancelled: true, previousVersion: clientVersion, newVersion };
    }
  }

  const tmpPath = `${targetPath}.agy-aio.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(packageFilePath, tmpPath);
    fs.chmodSync(tmpPath, 0o755);
    fs.renameSync(tmpPath, targetPath);
  } finally {
    removeFile(tmpPath);
  }
  chownToRealUser(targetPath, info);

  return {
    upgraded: true,
    os: 'linux',
    source,
    packagePath: packageFilePath,
    previousVersion: clientVersion,
    newVersion,
    targetPath
  };
}

async function resolveRemotePackageFile({ manifest, downloadUrl, cachedPath, dryRun, env, fetchImpl }) {
  // Reuse a cached download only when it matches the advertised checksum.
  if (fs.existsSync(cachedPath)) {
    if (!manifest.sha512) return { source: 'cache', filePath: cachedPath };
    const cached = await verifySha512Base64(cachedPath, manifest.sha512);
    if (cached.ok) return { source: 'cache', filePath: cachedPath };
    removeFile(cachedPath);
  }

  // A dry run only plans the download; never fetch the ~216 MB payload here.
  if (dryRun) return { source: 'remote', filePath: cachedPath };

  await downloadFile(downloadUrl, cachedPath, { timeoutMs: 600000, env, fetchImpl });
  if (manifest.sha512) {
    const downloaded = await verifySha512Base64(cachedPath, manifest.sha512);
    if (!downloaded.ok) {
      removeFile(cachedPath);
      throw new Error(`Downloaded package failed SHA-512 verification: ${cachedPath}`);
    }
  }
  return { source: 'remote', filePath: cachedPath };
}

/**
 * Upgrade the installed Antigravity desktop client.
 *
 * Resolution order: explicit local package, verified pending package against
 * the remote manifest, a verified cached/fresh download, and finally a
 * checksum-verified pending package when the network is unavailable.
 */
export async function upgradeClient({
  appDir = '',
  packagePath = '',
  dryRun = false,
  force = false,
  skipSignatureCheck = false,
  beforeSwap = null,
  platformInfo,
  installations,
  env = process.env,
  fetchImpl = fetch
} = {}) {
  const { info, installs, desktop } = resolveInstallation({ appDir, platformInfo, installations, env });
  if (!desktop) {
    return { upgraded: false, skipped: true, reason: 'antigravity-not-found' };
  }

  const clientVersion = readClientVersion(desktop, info);
  const appCodesign = info.os === 'darwin' ? checkCodesign(desktop.appBundlePath) : 'not-applicable';
  const pendingUpdate = getPendingUpdate({ appDir, platformInfo: info, installations: installs, env });
  const appUpdate = readAppUpdateConfig(desktop, info);
  const cachePaths = getUpdaterCachePaths(info, appUpdate.updaterCacheDirName, env);

  let manifest = null;
  let source = null;
  let resolvedPackagePath = '';

  if (packagePath) {
    const absolute = path.resolve(String(packagePath));
    let stat = null;
    try {
      stat = fs.statSync(absolute);
    } catch {
      // Reported below.
    }
    if (!stat || !stat.isFile()) {
      throw new Error(`Package not found or not a regular file: ${absolute}`);
    }
    source = 'local-package';
    resolvedPackagePath = absolute;
  } else {
    let remoteError = null;
    try {
      manifest = await fetchClientManifest({
        appDir,
        platformInfo: info,
        installations: installs,
        env,
        fetchImpl
      });
    } catch (error) {
      remoteError = error;
    }

    if (manifest) {
      const cmp = compareVersions(clientVersion, manifest.version);
      if (cmp !== null && cmp >= 0 && !force) {
        return {
          upgraded: false,
          alreadyLatest: true,
          previousVersion: clientVersion,
          newVersion: manifest.version,
          manifestUrl: manifest.manifestUrl
        };
      }

      if (pendingUpdate.exists && manifest.sha512) {
        const pending = await verifySha512Base64(pendingUpdate.filePath, manifest.sha512);
        if (pending.ok) {
          source = 'pending';
          resolvedPackagePath = pendingUpdate.filePath;
        }
      }

      if (!resolvedPackagePath) {
        const versionDir = normalizeVersionTag(manifest.version) || 'latest';
        const dataDir = info.dataDir || path.join(os.homedir(), '.agy-aio');
        const cachedPath = path.join(dataDir, 'cache', 'client', versionDir, manifest.fileName);
        const resolved = await resolveRemotePackageFile({
          manifest,
          downloadUrl: manifest.downloadUrl,
          cachedPath,
          dryRun,
          env,
          fetchImpl
        });
        source = resolved.source;
        resolvedPackagePath = resolved.filePath;
      }
    } else {
      if (!pendingUpdate.exists || !pendingUpdate.sha512) throw remoteError;
      const offline = await verifySha512Base64(pendingUpdate.filePath, pendingUpdate.sha512);
      if (!offline.ok) throw remoteError;
      source = 'pending-offline';
      resolvedPackagePath = pendingUpdate.filePath;
    }
  }

  if (dryRun) {
    return {
      upgraded: false,
      dryRun: true,
      os: info.os,
      previousVersion: clientVersion,
      newVersion: manifest?.version || null,
      source,
      packagePath: resolvedPackagePath || null,
      downloadUrl: manifest?.downloadUrl || null,
      targetPath: desktop.appBundlePath || desktop.rootDir,
      appCodesign
    };
  }

  if (info.os === 'darwin') {
    return applyMacUpgrade({
      desktop,
      packageFilePath: resolvedPackagePath,
      clientVersion,
      source,
      force,
      skipSignatureCheck,
      beforeSwap,
      info,
      cachePaths
    });
  }

  const newVersion = manifest?.version || null;
  const isAppImagePackage = /\.appimage$/i.test(resolvedPackagePath);
  const isAppImageInstall = /\.appimage$/i.test(String(desktop.exePath || ''));

  if (info.os === 'linux' && isAppImagePackage && isAppImageInstall) {
    return applyLinuxAppImageUpgrade({
      desktop,
      packageFilePath: resolvedPackagePath,
      clientVersion,
      newVersion,
      source,
      beforeSwap,
      info
    });
  }

  const installerLabel = info.os === 'win32' ? 'Windows installer (.exe)' : 'Linux package (.deb)';
  return {
    upgraded: false,
    prepared: true,
    manualInstallRequired: true,
    os: info.os,
    source,
    packagePath: resolvedPackagePath,
    previousVersion: clientVersion,
    newVersion,
    message:
      `The verified official ${installerLabel} is ready at "${resolvedPackagePath}". ` +
      'Run it manually to finish updating Antigravity.'
  };
}
