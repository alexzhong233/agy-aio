// Cross-platform proxy management: build, install, uninstall, and test the
// transparent Antigravity proxy. Node built-ins only.

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  getPlatformInfo,
  detectInstallations,
  atomicCopy,
  chownToRealUser,
  isPortOpen
} from '../platform.mjs';
import { loadConfig, saveConfig, syncConfigToTarget, getConfigPath } from '../config.mjs';
import { signBinaryAdhoc, checkCodesign } from '../codesign.mjs';
import { getLatestRelease, downloadFile, verifySha256Sums, extractZip } from '../net.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROXY_POSIX_DIR = path.join(REPO_ROOT, 'modules', 'proxy-posix');
const WINDOWS_PROXY_REPO = 'yuaotian/antigravity-proxy';

const POSIX_LIB_NAMES = ['libantigravity_proxy.dylib', 'libantigravity_proxy.so'];
const WINDOWS_DESKTOP_FILES = ['version.dll'];
const WINDOWS_CLI_FILES = ['dbghelp.dll', 'antigravity_proxy.dll'];
const WINDOWS_CLI_OPTIONAL_FILES = ['agy-acp-proxy.exe'];

/* ------------------------------------------------------------------ *
 * Small shared helpers
 * ------------------------------------------------------------------ */

function platformOf(info) {
  return (info && (info.os || info.platform)) || process.platform;
}

function dataDirOf(info) {
  if (info && info.dataDir) return info.dataDir;
  const home = (info && info.realUserHome) || process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.agy-aio');
}

function resolvePlatformInfo(platformInfo) {
  const info = platformInfo || getPlatformInfo();
  return info.dataDir ? info : { ...info, dataDir: dataDirOf(info) };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function extractConfig(config) {
  if (!config || typeof config !== 'object') return null;
  if (!config.proxy && config.config && typeof config.config === 'object') return config.config;
  return config;
}

function resolveConfig(config, platformInfo) {
  return extractConfig(config) || loadConfig(getConfigPath(platformInfo)).config;
}

function resolveInstallations({ appDir = '', platformInfo, installations, env = process.env }) {
  if (installations) return installations;
  return detectInstallations({ appDir, platformInfo, env });
}

function normalizedInstallations(installations) {
  const source = installations && typeof installations === 'object' ? installations : {};
  const desktop = [...asArray(source.desktop)];
  const ide = [...asArray(source.ide)];
  const cli = [...asArray(source.cli)];

  if (desktop.length === 0 && ide.length === 0 && cli.length === 0 && Array.isArray(source.allTargets)) {
    for (const entry of source.allTargets) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.kind === 'cli') cli.push(entry);
      else if (entry.kind === 'ide') ide.push(entry);
      else desktop.push(entry);
    }
  }

  return { desktop, ide, cli };
}

function collectPosixTargets(installations) {
  const result = [];
  const seen = new Set();

  const push = (kind, entry, targetPath) => {
    if (!targetPath) return;
    // detectInstallations() also reports the `.orig` backup once a target is
    // patched; it must never be treated as a live binary target.
    if (/\.orig$/i.test(targetPath)) return;
    const resolved = path.resolve(targetPath);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    result.push({
      kind,
      name: entry.name || kind,
      targetPath: resolved,
      appBundlePath: entry.appBundlePath || null,
      rootDir: entry.rootDir || null
    });
  };

  const { desktop, ide, cli } = normalizedInstallations(installations);
  for (const entry of desktop) {
    for (const targetPath of asArray(entry.languageServers)) push('desktop', entry, targetPath);
  }
  for (const entry of ide) {
    for (const targetPath of asArray(entry.languageServers)) push('ide', entry, targetPath);
  }
  for (const entry of cli) push('cli', entry, entry.cliBinPath || entry.exePath);

  return result;
}

function windowsTargetDir(entry) {
  if (entry && entry.exePath) return path.dirname(entry.exePath);
  if (entry && entry.resourcesDir) return entry.resourcesDir;
  if (entry && entry.rootDir) return entry.rootDir;
  return '';
}

function collectWindowsTargets(installations) {
  const result = [];
  const seen = new Set();

  const push = (kind, entry, targetDir) => {
    if (!targetDir) return;
    const resolved = path.resolve(targetDir);
    const key = `${kind}:${resolved.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({
      kind,
      name: entry.name || kind,
      targetDir: resolved,
      appBundlePath: entry.appBundlePath || null,
      rootDir: entry.rootDir || null
    });
  };

  const { desktop, ide, cli } = normalizedInstallations(installations);
  for (const entry of desktop) push('desktop', entry, windowsTargetDir(entry));
  for (const entry of ide) push('ide', entry, windowsTargetDir(entry));
  for (const entry of cli) {
    const binPath = entry.cliBinPath || entry.exePath;
    push('cli', entry, binPath ? path.dirname(binPath) : '');
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * POSIX helpers
 * ------------------------------------------------------------------ */

function getPosixArtifactPaths(platformInfo) {
  const os = platformOf(platformInfo);
  const libName = os === 'darwin' ? 'libantigravity_proxy.dylib' : 'libantigravity_proxy.so';
  const repoLib = path.join(PROXY_POSIX_DIR, libName);
  const repoLauncher = path.join(PROXY_POSIX_DIR, 'bin', 'anti-proxy-launcher');
  const cacheDir = path.join(dataDirOf(platformInfo), 'bin');
  const cacheLib = path.join(cacheDir, libName);
  const cacheLauncher = path.join(cacheDir, 'anti-proxy-launcher');
  const libPath = fs.existsSync(repoLib) ? repoLib : fs.existsSync(cacheLib) ? cacheLib : null;
  const launcherPath = fs.existsSync(repoLauncher)
    ? repoLauncher
    : fs.existsSync(cacheLauncher)
      ? cacheLauncher
      : null;

  return {
    os,
    libName,
    repoLib,
    repoLauncher,
    cacheDir,
    cacheLib,
    cacheLauncher,
    libPath,
    launcherPath
  };
}

export function buildPosixProxy({ universal = true, dryRun = false, platformInfo } = {}) {
  const info = resolvePlatformInfo(platformInfo);
  const os = platformOf(info);

  if (os !== 'darwin' && os !== 'linux') {
    return { built: false, skipped: true, reason: 'not-posix' };
  }

  const target = os === 'darwin' && universal ? 'universal' : 'all';
  const artifacts = getPosixArtifactPaths(info);

  if (dryRun) {
    return { built: false, dryRun: true, target };
  }

  execFileSync('make', ['-C', PROXY_POSIX_DIR, target], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: 600000,
    maxBuffer: 16 * 1024 * 1024
  });

  if (!fs.existsSync(artifacts.repoLib)) {
    throw new Error(`Build finished but ${artifacts.repoLib} was not produced.`);
  }
  if (!fs.existsSync(artifacts.repoLauncher)) {
    throw new Error(`Build finished but ${artifacts.repoLauncher} was not produced.`);
  }

  fs.mkdirSync(artifacts.cacheDir, { recursive: true });
  atomicCopy(artifacts.repoLib, artifacts.cacheLib, { mode: 0o755, platformInfo: info });
  chownToRealUser(artifacts.cacheLib, info);
  atomicCopy(artifacts.repoLauncher, artifacts.cacheLauncher, { mode: 0o755, platformInfo: info });
  chownToRealUser(artifacts.cacheLauncher, info);

  return { built: true, libPath: artifacts.cacheLib, launcherPath: artifacts.cacheLauncher };
}

// The compiled universal Mach-O launcher embeds "anti-proxy-launcher" at a
// fairly large offset (~18 KB), so a fixed 8 KB head read misses it. Real
// language_server binaries are tens of MB; only read a small head for those,
// and the whole file for small launchers/scripts/test fixtures.
function hasLauncherMarker(binPath) {
  if (!binPath) return false;

  let stat;
  try {
    stat = fs.statSync(binPath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const maxBytes = stat.size > 1024 * 1024 ? 64 * 1024 : stat.size;

  let fd = null;
  try {
    fd = fs.openSync(binPath, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = maxBytes > 0 ? fs.readSync(fd, buffer, 0, maxBytes, 0) : 0;
    const head = buffer.subarray(0, bytesRead);
    return (
      head.includes('anti-proxy-launcher') ||
      head.includes('DYLD_INSERT_LIBRARIES') ||
      head.includes('LD_PRELOAD')
    );
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best-effort close.
      }
    }
  }
}

function isPosixTargetPatched(binPath) {
  if (!binPath) return false;

  // A stale `.orig` + `.dylib` left next to a newly updated official
  // language_server must not be reported as patched, so require the launcher
  // marker in the live binary itself.
  const origPath = `${binPath}.orig`;
  return fs.existsSync(origPath) && hasLauncherMarker(binPath);
}

/* ------------------------------------------------------------------ *
 * Windows helpers
 * ------------------------------------------------------------------ */

function mapWindowsArch(arch) {
  return String(arch || '').toLowerCase() === 'ia32' ? 'x86' : 'x64';
}

function findAssetFile(baseDir, fileName) {
  if (!baseDir) return null;

  const direct = path.join(baseDir, fileName);
  if (fs.existsSync(direct)) return direct;

  let entries;
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = path.join(baseDir, entry.name, fileName);
    if (fs.existsSync(nested)) return nested;
  }

  return null;
}

function hasCachedWindowsAssets(platformInfo) {
  const root = path.join(dataDirOf(platformInfo), 'cache', 'proxy-win');
  const arch = mapWindowsArch(platformInfo && platformInfo.arch);
  let tags;
  try {
    tags = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory());
  } catch {
    return false;
  }

  for (const tag of tags) {
    const base = path.join(root, tag.name, arch);
    if (findAssetFile(path.join(base, 'ide'), 'version.dll') && findAssetFile(path.join(base, 'cli'), 'dbghelp.dll')) {
      return true;
    }
  }

  return false;
}

export function validateWindowsDeployPlan(planEntries) {
  if (!Array.isArray(planEntries)) {
    throw new TypeError('planEntries must be an array');
  }

  for (const entry of planEntries) {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError('Each deploy plan entry must be an object');
    }

    const kind = entry.kind;
    const targetDir = entry.targetDir || '(unknown)';
    const files = new Set(
      asArray(entry.files).map(file => String(file).replace(/\\/g, '/').split('/').pop().toLowerCase())
    );

    if (kind === 'desktop' || kind === 'ide') {
      for (const forbidden of ['dbghelp.dll', 'antigravity_proxy.dll']) {
        if (files.has(forbidden)) {
          throw new Error(
            `Refusing to deploy ${forbidden} into the ${kind} target "${targetDir}": ` +
              `${forbidden} is only valid for CLI targets.`
          );
        }
      }
      if (!files.has('version.dll')) {
        throw new Error(`Invalid ${kind} deploy plan for "${targetDir}": version.dll is required.`);
      }
      continue;
    }

    if (kind === 'cli') {
      if (files.has('version.dll')) {
        throw new Error(
          `Refusing to deploy version.dll into the CLI target "${targetDir}": ` +
            'version.dll is only valid for desktop/IDE targets.'
        );
      }
      for (const required of ['dbghelp.dll', 'antigravity_proxy.dll']) {
        if (!files.has(required)) {
          throw new Error(`Invalid CLI deploy plan for "${targetDir}": ${required} is required.`);
        }
      }
      continue;
    }

    throw new Error(`Invalid deploy plan entry for "${targetDir}": unknown target kind "${kind}".`);
  }

  return { valid: true };
}

function normalizeRelease(release) {
  if (!release || typeof release !== 'object') {
    throw new Error('Invalid release metadata returned by the release fetcher.');
  }

  const tag = release.tag || release.tag_name;
  if (!tag) {
    throw new Error('Release metadata is missing a tag.');
  }

  const assets = asArray(release.assets)
    .map(asset => ({
      name: asset && asset.name,
      url: asset && (asset.url || asset.browser_download_url)
    }))
    .filter(asset => asset.name && asset.url);

  return { tag, assets };
}

async function fetchRelease(releaseFetcher, env) {
  if (typeof releaseFetcher === 'function') return releaseFetcher(WINDOWS_PROXY_REPO, { env });
  if (releaseFetcher && typeof releaseFetcher.then === 'function') return releaseFetcher;
  if (releaseFetcher) return releaseFetcher;
  return getLatestRelease(WINDOWS_PROXY_REPO, { env });
}

export async function ensureWindowsProxyAssets({
  arch,
  dryRun = false,
  platformInfo,
  env = process.env,
  releaseFetcher
} = {}) {
  const info = resolvePlatformInfo(platformInfo);
  const targetArch = mapWindowsArch(arch || (info && info.arch) || process.arch);

  const release = normalizeRelease(await fetchRelease(releaseFetcher, env));

  const ideName = `antigravity-proxy-${release.tag}-ide-win-${targetArch}.zip`;
  const cliName = `antigravity-proxy-${release.tag}-cli-win-${targetArch}.zip`;
  const findAsset = name => release.assets.find(asset => asset.name === name) || null;
  const ideAsset = findAsset(ideName);
  const cliAsset = findAsset(cliName);
  const sumsAsset = release.assets.find(asset => /^sha256sums(\.txt)?$/i.test(asset.name)) || null;

  const missing = [];
  if (!ideAsset) missing.push(ideName);
  if (!cliAsset) missing.push(cliName);
  if (!sumsAsset) missing.push('SHA256SUMS.txt');
  if (missing.length > 0) {
    const available = release.assets.map(asset => asset.name).join(', ') || 'none';
    throw new Error(
      `Release ${release.tag} is missing required asset(s): ${missing.join(', ')}. Available: ${available}`
    );
  }

  const cacheDir = path.join(dataDirOf(info), 'cache', 'proxy-win', release.tag, targetArch);
  if (dryRun) {
    return { ready: false, dryRun: true, tag: release.tag, arch: targetArch, cacheDir };
  }

  fs.mkdirSync(cacheDir, { recursive: true });

  const sumsPath = path.join(cacheDir, 'SHA256SUMS.txt');
  const ideZipPath = path.join(cacheDir, ideName);
  const cliZipPath = path.join(cacheDir, cliName);

  await downloadFile(sumsAsset.url, sumsPath, { env });
  const sumsText = fs.readFileSync(sumsPath, 'utf8');

  await downloadFile(ideAsset.url, ideZipPath, { env });
  await downloadFile(cliAsset.url, cliZipPath, { env });

  for (const [zipPath, asset] of [
    [ideZipPath, ideAsset],
    [cliZipPath, cliAsset]
  ]) {
    const check = await verifySha256Sums(zipPath, asset.name, sumsText);
    if (!check.ok) {
      throw new Error(
        `SHA256 verification failed for ${asset.name}: ` +
          `expected ${check.expected || 'an entry in SHA256SUMS.txt'}, got ${check.actual}`
      );
    }
  }

  const ideDir = path.join(cacheDir, 'ide');
  const cliDir = path.join(cacheDir, 'cli');
  fs.rmSync(ideDir, { recursive: true, force: true });
  fs.rmSync(cliDir, { recursive: true, force: true });

  await extractZip(ideZipPath, ideDir);
  await extractZip(cliZipPath, cliDir);

  // The archives may either ship their payload at the root or inside an
  // `ide/` / `cli/` subfolder. Consumers resolve the real location with
  // findAssetFile(), so keep ideDir/cliDir as the stable extraction roots.
  return { ready: true, tag: release.tag, arch: targetArch, ideDir, cliDir };
}

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

export async function getProxyStatus({ appDir, config, platformInfo, installations, env = process.env } = {}) {
  const info = resolvePlatformInfo(platformInfo);
  const os = platformOf(info);
  const resolvedConfig = resolveConfig(config, info);
  const proxy = resolvedConfig.proxy || {};
  const portOpen =
    proxy.host && proxy.port ? await isPortOpen(proxy.host, proxy.port, 800) : false;

  const installs = installations || resolveInstallations({ appDir, platformInfo: info, env });
  const targets = [];
  const modifiedBundles = [];

  const noteBundle = appBundlePath => {
    if (appBundlePath && !modifiedBundles.includes(appBundlePath)) modifiedBundles.push(appBundlePath);
  };

  if (os === 'darwin' || os === 'linux') {
    const artifacts = getPosixArtifactPaths(info);

    for (const target of collectPosixTargets(installs)) {
      const targetPath = target.targetPath;
      const origPath = `${targetPath}.orig`;
      const binDir = path.dirname(targetPath);
      const libExists = POSIX_LIB_NAMES.some(name => fs.existsSync(path.join(binDir, name)));
      const patched = isPosixTargetPatched(targetPath);

      targets.push({
        kind: target.kind,
        name: target.name,
        targetPath,
        origPath,
        origExists: fs.existsSync(origPath),
        libExists,
        patched,
        codesign: checkCodesign(targetPath),
        appBundlePath: target.appBundlePath
      });

      if (patched) noteBundle(target.appBundlePath);
    }

    return {
      os,
      proxy,
      portOpen,
      artifactsReady: Boolean(artifacts.libPath && artifacts.launcherPath),
      targets,
      modifiedBundles
    };
  }

  if (os === 'win32') {
    for (const target of collectWindowsTargets(installs)) {
      const dir = target.targetDir;
      const configJsonExists = fs.existsSync(path.join(dir, 'config.json'));

      if (target.kind === 'cli') {
        const dbghelpDllExists = fs.existsSync(path.join(dir, 'dbghelp.dll'));
        const proxyDllExists = fs.existsSync(path.join(dir, 'antigravity_proxy.dll'));
        const agyAcpProxyExeExists = fs.existsSync(path.join(dir, 'agy-acp-proxy.exe'));
        const patched = dbghelpDllExists && proxyDllExists;

        targets.push({
          kind: 'cli',
          name: target.name,
          targetDir: dir,
          dbghelpDllExists,
          proxyDllExists,
          agyAcpProxyExeExists,
          configJsonExists,
          patched,
          appBundlePath: target.appBundlePath
        });

        if (patched) noteBundle(target.appBundlePath);
        continue;
      }

      const versionDllExists = fs.existsSync(path.join(dir, 'version.dll'));
      targets.push({
        kind: target.kind,
        name: target.name,
        targetDir: dir,
        versionDllExists,
        configJsonExists,
        patched: versionDllExists,
        appBundlePath: target.appBundlePath
      });

      if (versionDllExists) noteBundle(target.appBundlePath);
    }

    return {
      os,
      proxy,
      portOpen,
      artifactsReady: hasCachedWindowsAssets(info),
      targets,
      modifiedBundles
    };
  }

  return { os, proxy, portOpen, artifactsReady: false, targets, modifiedBundles };
}

/* ------------------------------------------------------------------ *
 * Install
 * ------------------------------------------------------------------ */

export async function installProxy({
  appDir,
  config,
  forceConfig = false,
  rebuild = false,
  dryRun = false,
  platformInfo,
  installations,
  env = process.env,
  windowsAssets
} = {}) {
  const info = resolvePlatformInfo(platformInfo);
  const os = platformOf(info);
  const resolvedConfig = resolveConfig(config, info);

  const configPath = getConfigPath(info);
  if (!dryRun && !fs.existsSync(configPath)) {
    saveConfig(resolvedConfig, configPath, info);
  }

  const installs = installations || resolveInstallations({ appDir, platformInfo: info, env });

  if (os === 'darwin' || os === 'linux') {
    let artifacts = getPosixArtifactPaths(info);
    let libPath = artifacts.libPath;
    let launcherPath = artifacts.launcherPath;

    if (rebuild || !libPath || !launcherPath) {
      const built = buildPosixProxy({ universal: true, dryRun, platformInfo: info });
      artifacts = getPosixArtifactPaths(info);
      libPath = (built && built.libPath) || artifacts.libPath || artifacts.repoLib;
      launcherPath = (built && built.launcherPath) || artifacts.launcherPath || artifacts.repoLauncher;
    }

    if (!dryRun && (!libPath || !fs.existsSync(libPath) || !launcherPath || !fs.existsSync(launcherPath))) {
      throw new Error('Antigravity proxy artifacts are not available. Run buildPosixProxy() first.');
    }

    const patchedTargets = [];
    const modifiedAppBundles = [];
    const libName = artifacts.libName;

    for (const target of collectPosixTargets(installs)) {
      const targetBin = target.targetPath;
      if (!dryRun && !fs.existsSync(targetBin)) continue;

      const origPath = `${targetBin}.orig`;
      const binDir = path.dirname(targetBin);
      const libDest = path.join(binDir, libName);

      if (dryRun) {
        patchedTargets.push(targetBin);
      } else {
        // An official update may have replaced targetBin with a fresh
        // unpatched binary while an old `.orig` still exists; in that case the
        // existing `.orig` is stale, so back up the NEW official binary.
        if (!fs.existsSync(origPath) || !hasLauncherMarker(targetBin)) {
          atomicCopy(targetBin, origPath, { mode: 0o755, platformInfo: info });
          signBinaryAdhoc(origPath);
        }

        atomicCopy(libPath, libDest, { mode: 0o755, platformInfo: info });
        syncConfigToTarget(binDir, resolvedConfig, { force: forceConfig, platformInfo: info });
        atomicCopy(launcherPath, targetBin, { mode: 0o755, platformInfo: info });
        signBinaryAdhoc(targetBin);
        patchedTargets.push(targetBin);
      }

      if (target.appBundlePath && !modifiedAppBundles.includes(target.appBundlePath)) {
        modifiedAppBundles.push(target.appBundlePath);
      }
    }

    return {
      installed: !dryRun,
      dryRun,
      patchedTargets,
      modifiedAppBundles,
      needsResign: os === 'darwin' && modifiedAppBundles.length > 0
    };
  }

  if (os === 'win32') {
    const assets =
      windowsAssets ||
      (await ensureWindowsProxyAssets({ arch: info.arch, dryRun, platformInfo: info, env }));

    if (!dryRun && (!assets || (!assets.ready && !(assets.ideDir && assets.cliDir)))) {
      throw new Error('Windows proxy assets are not ready.');
    }

    const ideRoot = assets && assets.ideDir;
    const cliRoot = assets && assets.cliDir;
    const plan = [];
    const rootsByTarget = new Map();

    for (const target of collectWindowsTargets(installs)) {
      if (target.kind === 'cli') {
        const files = [...WINDOWS_CLI_FILES];
        if (findAssetFile(cliRoot, WINDOWS_CLI_OPTIONAL_FILES[0])) {
          files.push(...WINDOWS_CLI_OPTIONAL_FILES);
        }
        plan.push({ kind: 'cli', targetDir: target.targetDir, files });
        rootsByTarget.set(target.targetDir, cliRoot);
      } else {
        plan.push({ kind: target.kind, targetDir: target.targetDir, files: [...WINDOWS_DESKTOP_FILES] });
        rootsByTarget.set(target.targetDir, ideRoot);
      }
    }

    validateWindowsDeployPlan(plan);

    if (!dryRun) {
      for (const entry of plan) {
        const root = rootsByTarget.get(entry.targetDir);
        for (const file of entry.files) {
          const source = findAssetFile(root, file);
          if (!source) {
            throw new Error(
              `Windows proxy asset ${file} was not found in ${root || '(missing asset directory)'}.`
            );
          }
          atomicCopy(source, path.join(entry.targetDir, file), { mode: 0o755, platformInfo: info });
        }
        syncConfigToTarget(entry.targetDir, resolvedConfig, { force: forceConfig, platformInfo: info });
      }
    }

    return {
      installed: !dryRun,
      dryRun,
      deployedTargets: plan.map(entry => entry.targetDir),
      needsResign: false
    };
  }

  return { installed: false, dryRun, deployedTargets: [], needsResign: false };
}

/* ------------------------------------------------------------------ *
 * Uninstall
 * ------------------------------------------------------------------ */

export async function uninstallProxy({ appDir, dryRun = false, platformInfo, installations, env = process.env } = {}) {
  const info = resolvePlatformInfo(platformInfo);
  const os = platformOf(info);
  const installs = installations || resolveInstallations({ appDir, platformInfo: info, env });
  const restoredTargets = [];
  const modifiedAppBundles = [];

  const noteBundle = appBundlePath => {
    if (appBundlePath && !modifiedAppBundles.includes(appBundlePath)) modifiedAppBundles.push(appBundlePath);
  };

  if (os === 'darwin' || os === 'linux') {
    for (const target of collectPosixTargets(installs)) {
      const targetBin = target.targetPath;
      const origPath = `${targetBin}.orig`;
      if (!fs.existsSync(origPath)) continue;

      const binDir = path.dirname(targetBin);

      if (!dryRun) {
        atomicCopy(origPath, targetBin, { mode: 0o755, platformInfo: info });
        fs.rmSync(origPath, { force: true });
        for (const name of POSIX_LIB_NAMES) {
          fs.rmSync(path.join(binDir, name), { force: true });
        }
        if (os === 'darwin') signBinaryAdhoc(targetBin);
      }

      restoredTargets.push(targetBin);
      noteBundle(target.appBundlePath);
    }

    return {
      restored: !dryRun,
      dryRun,
      restoredTargets,
      modifiedAppBundles,
      needsResign: os === 'darwin' && modifiedAppBundles.length > 0
    };
  }

  if (os === 'win32') {
    for (const target of collectWindowsTargets(installs)) {
      const files =
        target.kind === 'cli'
          ? [...WINDOWS_CLI_FILES, ...WINDOWS_CLI_OPTIONAL_FILES]
          : [...WINDOWS_DESKTOP_FILES];

      let removedAny = false;
      for (const file of files) {
        const filePath = path.join(target.targetDir, file);
        if (!fs.existsSync(filePath)) continue;
        if (!dryRun) fs.rmSync(filePath, { force: true });
        removedAny = true;
      }

      if (removedAny) {
        restoredTargets.push(target.targetDir);
        noteBundle(target.appBundlePath);
      }
    }

    return {
      restored: !dryRun,
      dryRun,
      restoredTargets,
      modifiedAppBundles,
      needsResign: false
    };
  }

  return { restored: false, dryRun, restoredTargets, modifiedAppBundles, needsResign: false };
}

/* ------------------------------------------------------------------ *
 * Connectivity testing and one-shot execution
 * ------------------------------------------------------------------ */

function buildSocks5ConnectRequest(targetHost, targetPort) {
  const hostBuffer = Buffer.from(String(targetHost), 'utf8');
  const port = Number(targetPort);

  if (hostBuffer.length === 0 || hostBuffer.length > 255) {
    throw new RangeError('SOCKS5 target host must be between 1 and 255 bytes.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError('SOCKS5 target port must be between 1 and 65535.');
  }

  const request = Buffer.alloc(7 + hostBuffer.length);
  request[0] = 0x05;
  request[1] = 0x01;
  request[2] = 0x00;
  request[3] = 0x03;
  request[4] = hostBuffer.length;
  hostBuffer.copy(request, 5);
  request.writeUInt16BE(port, 5 + hostBuffer.length);
  return request;
}

export async function testProxyConnectivity(
  config,
  { targetHost = 'daily-cloudcode-pa.googleapis.com', targetPort = 443, timeoutMs = 5000 } = {}
) {
  const cfg = extractConfig(config) || {};
  const proxy = cfg.proxy || {};
  const proxyHost = proxy.host || '127.0.0.1';
  const proxyPort = Number(proxy.port);
  const proxyType = String(proxy.type || 'socks5').toLowerCase() === 'http' ? 'http' : 'socks5';

  const startedAt = Date.now();
  const result = {
    ok: false,
    tcpReachable: false,
    handshakeOk: false,
    proxyHost,
    proxyPort: Number.isInteger(proxyPort) ? proxyPort : 0,
    proxyType,
    targetHost,
    targetPort,
    latencyMs: 0,
    error: null
  };

  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    result.error = 'invalid proxy port';
    return result;
  }

  return new Promise(resolve => {
    let settled = false;
    let tcpReachable = false;
    let stage = proxyType === 'http' ? 'http' : 'greeting';
    let buffer = Buffer.alloc(0);
    let timer = null;
    const socket = new net.Socket();

    function finish(ok, error) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      result.tcpReachable = tcpReachable;
      result.handshakeOk = Boolean(ok);
      result.ok = Boolean(ok && tcpReachable);
      result.latencyMs = Date.now() - startedAt;
      result.error = error || null;
      socket.destroy();
      resolve(result);
    }

    timer = setTimeout(() => finish(false, `timeout after ${timeoutMs}ms`), timeoutMs);

    socket.setNoDelay(true);

    socket.once('connect', () => {
      tcpReachable = true;
      if (proxyType === 'http') {
        socket.write(
          `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`
        );
        return;
      }
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });

    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);

      if (proxyType === 'http') {
        const text = buffer.toString('latin1');
        const headerEnd = text.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;

        const lineEnd = text.indexOf('\r\n');
        const statusLine = text.slice(0, lineEnd >= 0 ? lineEnd : headerEnd);
        const match = /^HTTP\/1\.[01]\s+(\d{3})/i.exec(statusLine);

        if (match && match[1] === '200') finish(true, null);
        else finish(false, `HTTP CONNECT failed: ${statusLine.trim() || 'empty response'}`);
        return;
      }

      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        if (buffer[0] !== 0x05 || buffer[1] !== 0x00) {
          finish(false, `SOCKS5 greeting failed (method=${buffer[1]})`);
          return;
        }

        buffer = buffer.subarray(2);
        stage = 'connect';

        try {
          socket.write(buildSocks5ConnectRequest(targetHost, targetPort));
        } catch (error) {
          finish(false, error && error.message ? error.message : String(error));
        }
        return;
      }

      if (stage === 'connect') {
        if (buffer.length < 4) return;
        if (buffer[0] !== 0x05) {
          finish(false, 'SOCKS5 CONNECT reply has an invalid version');
          return;
        }
        if (buffer[1] !== 0x00) {
          finish(false, `SOCKS5 CONNECT failed (rep=${buffer[1]})`);
          return;
        }
        finish(true, null);
      }
    });

    socket.once('error', error => {
      finish(false, error && error.message ? error.message : String(error));
    });

    socket.once('close', () => {
      if (!settled) finish(false, 'connection closed before handshake completed');
    });

    try {
      socket.connect(proxyPort, proxyHost);
    } catch (error) {
      finish(false, error && error.message ? error.message : String(error));
    }
  });
}

export function runWithProxy(cmdArgs, config, { platformInfo, env = process.env } = {}) {
  if (!Array.isArray(cmdArgs) || cmdArgs.length === 0) {
    throw new TypeError('cmdArgs must be a non-empty array');
  }

  const info = resolvePlatformInfo(platformInfo);
  const os = platformOf(info);
  const cfg = extractConfig(config) || {};
  const proxy = cfg.proxy || {};
  const host = proxy.host || '127.0.0.1';
  const port = Number(proxy.port) || 0;
  const proxyType = String(proxy.type || 'socks5').toLowerCase() === 'http' ? 'http' : 'socks5';

  const childEnv = { ...env, ANTIGRAVITY_PROXY_CONFIG: getConfigPath(info) };

  if (os === 'darwin' || os === 'linux') {
    const artifacts = getPosixArtifactPaths(info);
    const libPath = artifacts.libPath || artifacts.cacheLib;
    if (os === 'darwin') childEnv.DYLD_INSERT_LIBRARIES = libPath;
    else childEnv.LD_PRELOAD = libPath;
  } else if (os === 'win32') {
    const url = `${proxyType}://${host}:${port}`;
    childEnv.HTTP_PROXY = url;
    childEnv.HTTPS_PROXY = url;
    childEnv.ALL_PROXY = url;
  }

  const child = spawnSync(cmdArgs[0], cmdArgs.slice(1), {
    stdio: 'inherit',
    env: childEnv
  });

  return { status: child.status };
}
