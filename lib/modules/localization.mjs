// Chinese localization orchestration for Antigravity Desktop.
// Node built-ins only; CJS helpers are loaded from the vendored localization bundle.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { getPlatformInfo, detectInstallations, atomicCopy, chownToRealUser } from '../platform.mjs';
import { getLatestRelease, downloadFile, verifySha256Sums, fetchJson } from '../net.mjs';

const require = createRequire(import.meta.url);
const { readAsarPackageVersion } = require('../../modules/localization/asar-version.js');
const { isLocalizedAsar } = require('../../modules/localization/auto-restore.js');
const { findValidOfficialBackup, normalizeVersion } = require('../../modules/localization/src/backup-utils.js');

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LOCALIZATION_ROOT = path.join(REPO_ROOT, 'modules', 'localization');
export const UPSTREAM_REPO = 'antigravity-cn-community/Antigravity-Chinese-Localization';

const LOCALIZE_SCRIPT = path.join(LOCALIZATION_ROOT, 'localize.js');
const VERSION_HEAD_BYTES = 4 * 1024;
const LOCAL_BUILD_TIMEOUT_MS = 300000;
const MODES = new Set(['auto', 'online', 'local']);

function readVersionConstant(head, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*['"]([^'"]+)['"]`).exec(head);
  return match ? match[1].trim() : null;
}

// The bundled patch tracks two numbers: CURRENT_VERSION (matched to the client
// build) and RELEASE_VERSION (patch release counter). Prefer the former so the
// reported version lines up with the client, and fall back to package.json.
function readBundledVersion() {
  try {
    const fd = fs.openSync(LOCALIZE_SCRIPT, 'r');
    let head = '';
    try {
      const buffer = Buffer.alloc(VERSION_HEAD_BYTES);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      head = buffer.subarray(0, bytes).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const current = readVersionConstant(head, 'CURRENT_VERSION');
    const release = readVersionConstant(head, 'RELEASE_VERSION');
    if (current || release) return current || release;
  } catch {
    // Fall through to the package manifest.
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(LOCALIZATION_ROOT, 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' && manifest.version.trim() ? manifest.version.trim() : null;
  } catch {
    return null;
  }
}

export function evaluateLocalizationCompatibility({ clientVersion, patchVersion, bundledVersion } = {}) {
  const targetPatch = patchVersion ?? bundledVersion;

  if (!clientVersion || !targetPatch) {
    return {
      status: 'unknown',
      compatible: true,
      clientVersion: clientVersion || null,
      patchVersion: targetPatch || null,
      message: '无法读取完整版本信息，安装时需谨慎核对版本。'
    };
  }

  if (normalizeVersion(clientVersion) === normalizeVersion(targetPatch)) {
    return {
      status: 'match',
      compatible: true,
      clientVersion,
      patchVersion: targetPatch,
      message: `客户端版本 (${clientVersion}) 与汉化补丁 (${targetPatch}) 精确匹配。`
    };
  }

  return {
    status: 'mismatch',
    compatible: false,
    clientVersion,
    patchVersion: targetPatch,
    message: `客户端版本 (${clientVersion}) 与汉化补丁 (${targetPatch}) 不一致，强行覆盖可能导致白屏或异常。`
  };
}

function lstatOrNull(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

// Never follow or replace a symlink: app.asar and its backups must be regular
// files inside the install. Returns whether the path already exists.
function assertNotSymlink(targetPath, label) {
  const stat = lstatOrNull(targetPath);
  if (stat && stat.isSymbolicLink()) {
    throw new Error(`Refusing to operate on symlinked ${label}: ${targetPath}`);
  }
  return Boolean(stat);
}

function findAsset(assets, names) {
  const list = Array.isArray(assets) ? assets : [];
  for (const name of names) {
    const found = list.find(asset => asset && asset.name === name);
    if (found) return found;
  }
  return null;
}

function removeQuietly(targetPath) {
  try {
    fs.rmSync(targetPath, { force: true });
  } catch {
    // Best-effort cache cleanup.
  }
}

export function resolveLocalizationTarget({ appDir, platformInfo, installations, env = process.env } = {}) {
  const info = platformInfo || getPlatformInfo({ env });
  const detected = installations || detectInstallations({ appDir, platformInfo: info, env });
  const desktop = (detected && detected.primaryDesktop) || null;

  return {
    found: Boolean(desktop && desktop.asarPath && fs.existsSync(desktop.asarPath)),
    target: desktop,
    asarPath: (desktop && desktop.asarPath) || null,
    backupAsarPath: (desktop && desktop.backupAsarPath) || null,
    resourcesDir: (desktop && desktop.resourcesDir) || null,
    appBundlePath: (desktop && desktop.appBundlePath) || null
  };
}

export function getLocalizationStatus({ appDir, platformInfo, installations, env = process.env } = {}) {
  const info = platformInfo || getPlatformInfo({ env });
  const target = resolveLocalizationTarget({ appDir, platformInfo: info, installations, env });
  const bundledVersion = readBundledVersion();

  if (!target.found || !target.asarPath || !fs.existsSync(target.asarPath)) {
    return {
      found: false,
      localized: false,
      clientVersion: null,
      hasValidBackup: false,
      backupVersion: null,
      bundledVersion,
      versionMatch: 'unknown',
      compatibilityMessage: '未检测到 Antigravity Desktop 安装。',
      asarPath: target.asarPath,
      resourcesDir: target.resourcesDir,
      appBundlePath: target.appBundlePath
    };
  }

  const clientVersion = readAsarPackageVersion(target.asarPath);
  const localized = isLocalizedAsar(target.asarPath);
  const compat = evaluateLocalizationCompatibility({
    clientVersion,
    patchVersion: bundledVersion,
    bundledVersion
  });

  const isAlreadyLocalizedClient = Boolean(localized && clientVersion);
  const versionMatch = isAlreadyLocalizedClient ? 'match' : compat.status;
  const compatibilityMessage =
    isAlreadyLocalizedClient && compat.status !== 'match'
      ? `当前客户端 (${clientVersion}) 已完成汉化（仓库内置离线补丁为 ${bundledVersion || '未知'}，重装/恢复时将自动拉取在线匹配版本）。`
      : compat.message;

  const backupResult = findValidOfficialBackup({
    resourcesDir: target.resourcesDir,
    targetVersion: clientVersion,
    isLocalizedAsar
  });
  const backupExists = Boolean(target.backupAsarPath && fs.existsSync(target.backupAsarPath));

  return {
    found: true,
    localized,
    clientVersion,
    hasValidBackup: Boolean(backupResult.match),
    backupExists,
    backupPath: (backupResult.match && backupResult.match.path) || null,
    backupVersion: (backupResult.match && backupResult.match.version) || null,
    staleBackupCount: (backupResult.staleBackups && backupResult.staleBackups.length) || 0,
    bundledVersion,
    bundledVersionMatch: compat.status,
    versionMatch,
    compatibilityMessage,
    asarPath: target.asarPath,
    backupAsarPath: target.backupAsarPath,
    resourcesDir: target.resourcesDir,
    appBundlePath: target.appBundlePath
  };
}

// Mirrors the safety rules in localize.js: only pristine archives become
// backups, a localized backup is refreshed from a clean client, and a backup
// from an older client is replaced after an official update.
export function ensureOfficialBackup({ asarPath, backupAsarPath, clientVersion, dryRun = false, platformInfo } = {}) {
  if (!asarPath) throw new Error('ensureOfficialBackup requires asarPath');
  if (!backupAsarPath) throw new Error('ensureOfficialBackup requires backupAsarPath');

  assertNotSymlink(asarPath, 'app.asar');
  const backupExists = assertNotSymlink(backupAsarPath, 'app.asar.bak');

  if (!backupExists) {
    if (isLocalizedAsar(asarPath)) {
      return { created: false, skipped: true, reason: 'source-already-localized' };
    }
    if (!dryRun) atomicCopy(asarPath, backupAsarPath, { platformInfo });
    return { created: !dryRun, dryRun, backupAsarPath, version: clientVersion ?? null };
  }

  if (isLocalizedAsar(backupAsarPath)) {
    if (!isLocalizedAsar(asarPath)) {
      if (!dryRun) atomicCopy(asarPath, backupAsarPath, { platformInfo });
      return {
        refreshed: !dryRun,
        dryRun,
        reason: 'backup-was-localized',
        backupAsarPath,
        version: clientVersion ?? null
      };
    }
    return { created: false, skipped: true, reason: 'both-localized' };
  }

  if (!isLocalizedAsar(asarPath)) {
    const bakVer = normalizeVersion(readAsarPackageVersion(backupAsarPath));
    const normClient = normalizeVersion(clientVersion);

    if (normClient && bakVer && normClient !== bakVer) {
      if (!dryRun) atomicCopy(asarPath, backupAsarPath, { platformInfo });
      return {
        refreshed: !dryRun,
        dryRun,
        reason: 'client-updated',
        oldVersion: bakVer,
        newVersion: normClient,
        backupAsarPath,
        version: normClient
      };
    }

    return { created: false, skipped: true, reason: 'valid-backup-exists' };
  }

  return { created: false, skipped: true, reason: 'valid-backup-exists' };
}

async function installFromRelease({
  release,
  target,
  clientVersion,
  mode,
  platformInfo,
  env
}) {
  const patchAsset =
    findAsset(release.assets, ['app.asar.ready']) || findAsset(release.assets, ['app.asar']);
  const sumsAsset = findAsset(release.assets, ['SHA256SUMS.txt']);

  if (!patchAsset) {
    throw new Error(`Release ${release.tag} does not provide app.asar.ready or app.asar`);
  }
  if (!sumsAsset) {
    throw new Error(
      `Release ${release.tag} does not provide SHA256SUMS.txt; refusing to install an unverified localization patch`
    );
  }

  const cacheDir = path.join(platformInfo.dataDir, 'cache', 'localization', release.tag);
  const sumsPath = path.join(cacheDir, sumsAsset.name);
  const cachedAsar = path.join(cacheDir, patchAsset.name);

  fs.mkdirSync(cacheDir, { recursive: true });
  await downloadFile(sumsAsset.url, sumsPath, { env });
  const sumsText = fs.readFileSync(sumsPath, 'utf8');

  let cacheIsValid = false;
  if (fs.existsSync(cachedAsar)) {
    const cachedCheck = await verifySha256Sums(cachedAsar, patchAsset.name, sumsText);
    cacheIsValid = cachedCheck.ok;
  }

  if (!cacheIsValid) {
    await downloadFile(patchAsset.url, cachedAsar, { env });
  }

  const verification = await verifySha256Sums(cachedAsar, patchAsset.name, sumsText);
  if (!verification.ok) {
    removeQuietly(cachedAsar);
    throw new Error(
      `SHA256 verification failed for ${patchAsset.name}: expected ${
        verification.expected || 'an entry in SHA256SUMS.txt'
      }, got ${verification.actual}`
    );
  }

  const patchVersion = readAsarPackageVersion(cachedAsar);
  if (clientVersion && !patchVersion) {
    const err = new Error(
      `无法读取在线汉化补丁版本号（客户端当前版本 ${clientVersion}），已拒绝安装以防不兼容。`
    );
    err.isVersionMismatch = true;
    err.code = 'VERSION_MISMATCH';
    throw err;
  }
  if (
    clientVersion &&
    patchVersion &&
    normalizeVersion(patchVersion) !== normalizeVersion(clientVersion)
  ) {
    const err = new Error(
      `Localization patch version ${patchVersion} does not match client version ${clientVersion}` +
        (mode === 'online' ? '; refusing to overwrite the client' : '')
    );
    err.isVersionMismatch = true;
    err.code = 'VERSION_MISMATCH';
    throw err;
  }

  ensureOfficialBackup({
    asarPath: target.asarPath,
    backupAsarPath: target.backupAsarPath,
    clientVersion,
    platformInfo
  });
  atomicCopy(cachedAsar, target.asarPath, { platformInfo });

  return {
    installed: true,
    method: 'online',
    tag: release.tag,
    clientVersion,
    patchVersion,
    asarPath: target.asarPath,
    appBundlePath: target.appBundlePath,
    needsResign: platformInfo.os === 'darwin'
  };
}

function installFromLocalSource({ target, platformInfo, env }) {
  const defaultDesktop = detectInstallations({ platformInfo, env }).primaryDesktop || null;
  const defaultAsar = (defaultDesktop && defaultDesktop.asarPath) || null;
  const isDefaultTarget = Boolean(
    defaultAsar && target.asarPath && path.resolve(defaultAsar) === path.resolve(target.asarPath)
  );

  if (!isDefaultTarget) {
    console.warn(
      '[agy-aio] Custom Antigravity path detected; localize.js rebuilds the default installation, ' +
        `not ${target.asarPath}.`
    );
  }

  execFileSync(process.execPath, [LOCALIZE_SCRIPT, '--now'], {
    cwd: LOCALIZATION_ROOT,
    stdio: 'inherit',
    timeout: LOCAL_BUILD_TIMEOUT_MS
  });

  if (isDefaultTarget && !isLocalizedAsar(target.asarPath)) {
    throw new Error(`Local rebuild finished but ${target.asarPath} is still not localized`);
  }

  return isDefaultTarget;
}

export async function installLocalization({
  appDir,
  mode = 'auto',
  dryRun = false,
  allowVersionMismatch = false,
  platformInfo,
  installations,
  env = process.env,
  releaseFetcher
} = {}) {
  if (!MODES.has(mode)) {
    throw new TypeError(`Unsupported localization mode: ${mode}`);
  }

  const info = platformInfo || getPlatformInfo({ env });
  const target = resolveLocalizationTarget({ appDir, platformInfo: info, installations, env });

  if (!target.found) {
    return { installed: false, skipped: true, reason: 'antigravity-not-found' };
  }

  const clientVersion = readAsarPackageVersion(target.asarPath);
  const bundledVersion = readBundledVersion();

  if (dryRun) {
    const compat = evaluateLocalizationCompatibility({ clientVersion, patchVersion: bundledVersion, bundledVersion });
    return {
      installed: false,
      dryRun: true,
      mode,
      clientVersion,
      bundledVersion,
      versionMatch: compat.status,
      compatibilityMessage: compat.message,
      asarPath: target.asarPath,
      appBundlePath: target.appBundlePath
    };
  }

  if (mode === 'online' || mode === 'auto') {
    try {
      const release = releaseFetcher
        ? await releaseFetcher()
        : await getLatestRelease(UPSTREAM_REPO, { env });
      return await installFromRelease({ release, target, clientVersion, mode, platformInfo: info, env });
    } catch (error) {
      if (mode === 'online') throw error;

      if (error && error.code === 'VERSION_MISMATCH') {
        const bundledMatchesClient =
          normalizeVersion(bundledVersion) === normalizeVersion(clientVersion);
        if (!bundledMatchesClient && !allowVersionMismatch) {
          throw new Error(
            `在线汉化补丁与客户端版本不匹配（${error.message}），且本地内置汉化版本 (${bundledVersion || '未知'}) ` +
              `与客户端版本 (${clientVersion || '未知'}) 不一致，已拒绝自动回退本地重建以防白屏。` +
              '请等待上游汉化补丁更新，或使用 --allow-version-mismatch / --l10n-mode local 手动继续。'
          );
        }
      } else if (!allowVersionMismatch) {
        const fallbackCompat = evaluateLocalizationCompatibility({ clientVersion, bundledVersion });
        if (fallbackCompat.status === 'mismatch') {
          throw new Error(
            `在线汉化下载失败（${error && error.message ? error.message : error}），且本地内置汉化版本 ` +
              `(${bundledVersion || '未知'}) 与客户端版本 (${clientVersion || '未知'}) 不一致，已拒绝回退本地重建以防白屏。` +
              '请等待上游汉化补丁更新，或使用 --allow-version-mismatch / --l10n-mode local 手动继续。'
          );
        }
      }

      console.warn(
        `[agy-aio] Online localization unavailable (${error && error.message ? error.message : error}); ` +
          'falling back to a local rebuild.'
      );
    }
  }

  installFromLocalSource({ target, platformInfo: info, env });

  return {
    installed: true,
    method: 'local',
    clientVersion,
    asarPath: target.asarPath,
    appBundlePath: target.appBundlePath,
    needsResign: info.os === 'darwin'
  };
}

export async function restoreLocalization({
  appDir,
  mode = 'auto',
  dryRun = false,
  allowVersionMismatch = false,
  platformInfo,
  installations,
  env = process.env,
  releaseFetcher
} = {}) {
  return installLocalization({
    appDir,
    mode,
    dryRun,
    allowVersionMismatch,
    platformInfo,
    installations,
    env,
    releaseFetcher
  });
}

export function uninstallLocalization({ appDir, dryRun = false, platformInfo, installations, env = process.env } = {}) {
  const info = platformInfo || getPlatformInfo({ env });
  const target = resolveLocalizationTarget({ appDir, platformInfo: info, installations, env });

  if (!target.found || !target.asarPath) {
    return { restored: false, skipped: true, reason: 'antigravity-not-found' };
  }

  const clientVersion = readAsarPackageVersion(target.asarPath);
  const backupSearch = findValidOfficialBackup({
    resourcesDir: target.resourcesDir,
    targetVersion: clientVersion,
    isLocalizedAsar
  });

  if (!backupSearch.match) {
    const staleBackups = backupSearch.staleBackups || [];
    if (staleBackups.length > 0) {
      throw new Error(
        `Found only an app.asar backup for a different client version (` +
          `${staleBackups[0].version || 'unknown'} vs current ${clientVersion || 'unknown'}); ` +
          'restoring it would white-screen Antigravity. Download a matching official client first.'
      );
    }

    if (!isLocalizedAsar(target.asarPath)) {
      return { restored: false, alreadyOriginal: true, asarPath: target.asarPath };
    }

    throw new Error(
      `No valid unlocalized app.asar.bak backup found in ${target.resourcesDir}; cannot restore the original client`
    );
  }

  if (dryRun) {
    return {
      restored: false,
      dryRun: true,
      backupPath: backupSearch.match.path,
      asarPath: target.asarPath
    };
  }

  atomicCopy(backupSearch.match.path, target.asarPath, { platformInfo: info });

  return {
    restored: true,
    backupPath: backupSearch.match.path,
    asarPath: target.asarPath,
    appBundlePath: target.appBundlePath,
    needsResign: info.os === 'darwin'
  };
}
