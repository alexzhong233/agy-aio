// agy-capsule lifecycle helpers: locate, install, uninstall and update the
// Gemini CLI plugin that ships with this repository. Node built-ins only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getPlatformInfo,
  detectInstallations,
  chownToRealUser,
  atomicCopy
} from '../platform.mjs';
import {
  getLatestRelease,
  downloadFile,
  extractTarGz,
  extractZip
} from '../net.mjs';
import { getCdpStatus, setupCdpLauncher } from '../launcher.mjs';
import { compareVersions } from '../version.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLED_SRC_DIR = path.join(REPO_ROOT, 'modules', 'capsule', 'agy-capsule');
const UPSTREAM_REPO = 'Lumidarin/agy-capsule';

const UPDATE_MARKER = '.update-in-progress';

// An explicit cdpMode always wins (including 'none', which cleans up a
// previous native/wrapper setup). Without one, setupCdp keeps the historical
// "do nothing when false" behaviour.
function runCdpSetup({ setupCdp, cdpMode, dryRun, platformInfo, installations }) {
  if (cdpMode !== undefined && cdpMode !== null) {
    return setupCdpLauncher({ mode: cdpMode, dryRun, platformInfo, installations });
  }
  if (setupCdp) {
    return setupCdpLauncher({ mode: 'wrapper', dryRun, platformInfo, installations });
  }
  return null;
}

function readPluginVersion(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    return typeof manifest.version === 'string' && manifest.version ? manifest.version : null;
  } catch {
    return null;
  }
}

function assertNotSymlink(target, label = 'Plugin destination') {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} is a symlink: ${target}`);
  }
}

function chownTree(target, platformInfo) {
  chownToRealUser(target, platformInfo);
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return;
  }
  if (!stat.isDirectory()) return;

  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    chownTree(path.join(target, entry.name), platformInfo);
  }
}

function copyTree(sourceDir, destDir, platformInfo) {
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const source = path.join(sourceDir, entry.name);
    const dest = path.join(destDir, entry.name);
    const stat = fs.lstatSync(source);

    if (stat.isSymbolicLink()) {
      try {
        fs.rmSync(dest, { recursive: true, force: true });
      } catch {
        // The destination may not exist yet.
      }
      fs.symlinkSync(fs.readlinkSync(source), dest);
      // fs.chownSync follows symlinks, so ownership of links is left untouched.
      continue;
    }

    if (stat.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      fs.chmodSync(dest, stat.mode & 0o7777);
      copyTree(source, dest, platformInfo);
      chownToRealUser(dest, platformInfo);
      continue;
    }

    atomicCopy(source, dest, { mode: stat.mode & 0o7777, platformInfo });
  }
}

export function getPluginRoot({ pluginsDir, platformInfo, env = process.env } = {}) {
  const info = platformInfo || getPlatformInfo({ env });
  const pluginRoot =
    pluginsDir ||
    (env && env.AGY_CAPSULE_PLUGINS_DIR) ||
    path.join(info.realUserHome, '.gemini', 'config', 'plugins');

  return {
    pluginRoot,
    pluginDir: path.join(pluginRoot, 'agy-capsule'),
    settingsPath: path.join(info.realUserHome, '.gemini', 'config', 'agy-capsule', 'settings.json')
  };
}

export function getCapsuleStatus({ pluginsDir, platformInfo, installations, env = process.env } = {}) {
  const info = platformInfo || getPlatformInfo({ env });
  const { pluginRoot, pluginDir, settingsPath } = getPluginRoot({ pluginsDir, platformInfo: info, env });

  const bundledVersion = readPluginVersion(BUNDLED_SRC_DIR);
  const installedVersion = readPluginVersion(pluginDir);
  const installed = fs.existsSync(pluginDir);
  const cdp = getCdpStatus({
    platformInfo: info,
    installations: installations || detectInstallations({ platformInfo: info, env })
  });

  return {
    installed,
    installedVersion,
    bundledVersion,
    pluginRoot,
    pluginDir,
    settingsExists: fs.existsSync(settingsPath),
    cdp
  };
}

export function installCapsule({
  sourceDir = BUNDLED_SRC_DIR,
  pluginsDir,
  setupCdp = true,
  cdpMode,
  dryRun = false,
  allowDowngrade = false,
  platformInfo,
  installations,
  env = process.env
} = {}) {
  const info = platformInfo || getPlatformInfo({ env });

  if (!fs.existsSync(path.join(sourceDir, 'plugin.json'))) {
    throw new Error(`Capsule source is missing plugin.json: ${sourceDir}`);
  }

  const { pluginRoot, pluginDir } = getPluginRoot({ pluginsDir, platformInfo: info, env });
  const version = readPluginVersion(sourceDir);
  const installedVersion = readPluginVersion(pluginDir);

  assertNotSymlink(pluginDir);

  if (path.resolve(sourceDir) === path.resolve(pluginDir)) {
    throw new Error(`Refusing to install capsule onto itself: ${pluginDir}`);
  }

  const isDowngrade =
    !allowDowngrade &&
    Boolean(installedVersion && version && compareVersions(installedVersion, version) > 0);

  if (isDowngrade) {
    const cdp = runCdpSetup({ setupCdp, cdpMode, dryRun, platformInfo: info, installations });
    return {
      installed: !dryRun,
      ...(dryRun ? { dryRun: true } : {}),
      preservedNewer: true,
      keptVersion: installedVersion,
      sourceVersion: version,
      version: installedVersion,
      pluginDir,
      cdp,
      needsResign: Boolean(cdp && cdp.needsResign),
      appBundlePath: (cdp && cdp.appBundlePath) || null
    };
  }

  if (dryRun) {
    const cdp = runCdpSetup({ setupCdp, cdpMode, dryRun: true, platformInfo: info, installations });
    return {
      installed: false,
      dryRun: true,
      pluginDir,
      version,
      cdp,
      needsResign: Boolean(cdp && cdp.needsResign),
      appBundlePath: (cdp && cdp.appBundlePath) || null
    };
  }

  fs.mkdirSync(pluginDir, { recursive: true });
  const markerPath = path.join(pluginDir, UPDATE_MARKER);
  fs.writeFileSync(markerPath, 'Updating agy-capsule\n');

  try {
    for (const entry of fs.readdirSync(pluginDir)) {
      if (entry === UPDATE_MARKER) continue;
      fs.rmSync(path.join(pluginDir, entry), { recursive: true, force: true });
    }
    copyTree(sourceDir, pluginDir, info);
  } finally {
    fs.rmSync(markerPath, { force: true });
  }

  chownTree(pluginRoot, info);
  chownTree(pluginDir, info);

  const cdp = runCdpSetup({ setupCdp, cdpMode, dryRun: false, platformInfo: info, installations });

  return {
    installed: true,
    pluginDir,
    version,
    cdp,
    needsResign: Boolean(cdp && cdp.needsResign),
    appBundlePath: (cdp && cdp.appBundlePath) || null
  };
}

export function uninstallCapsule({
  pluginsDir,
  undoCdp = false,
  dryRun = false,
  platformInfo,
  installations,
  env = process.env
} = {}) {
  const info = platformInfo || getPlatformInfo({ env });
  const { pluginDir, settingsPath } = getPluginRoot({ pluginsDir, platformInfo: info, env });

  assertNotSymlink(pluginDir);

  const cdp =
    undoCdp === true
      ? setupCdpLauncher({ dryRun, undo: true, platformInfo: info, installations })
      : null;
  const cdpFields = {
    cdp,
    needsResign: Boolean(cdp && cdp.needsResign),
    appBundlePath: (cdp && cdp.appBundlePath) || null
  };

  if (!fs.existsSync(pluginDir)) {
    return {
      removed: false,
      alreadyAbsent: true,
      pluginDir,
      settingsPreserved: fs.existsSync(settingsPath),
      ...cdpFields
    };
  }

  if (dryRun) {
    return {
      removed: false,
      dryRun: true,
      pluginDir,
      settingsPreserved: fs.existsSync(settingsPath),
      ...cdpFields
    };
  }

  fs.rmSync(pluginDir, { recursive: true, force: true });

  return {
    removed: true,
    pluginDir,
    settingsPreserved: fs.existsSync(settingsPath),
    ...cdpFields
  };
}

function findCapsuleDir(extractedDir) {
  if (fs.existsSync(path.join(extractedDir, 'agy-capsule', 'plugin.json'))) return path.join(extractedDir, 'agy-capsule');

  let entries;
  try {
    entries = fs.readdirSync(extractedDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(extractedDir, entry.name);
    if (fs.existsSync(path.join(candidate, 'agy-capsule', 'plugin.json'))) return path.join(candidate, 'agy-capsule');
  }

  return null;
}

export async function updateCapsuleFromUpstream({
  pluginsDir,
  setupCdp = false,
  cdpMode,
  dryRun = false,
  allowDowngrade = false,
  platformInfo,
  installations,
  env = process.env,
  releaseFetcher
} = {}) {
  const info = platformInfo || getPlatformInfo({ env });
  const release = releaseFetcher
    ? await releaseFetcher()
    : await getLatestRelease(UPSTREAM_REPO, { env });
  const cacheDir = path.join(info.dataDir, 'cache', 'capsule', release.tag);

  const { pluginDir } = getPluginRoot({ pluginsDir, platformInfo: info, env });
  const currentVersion = readPluginVersion(pluginDir);
  const alreadyLatest =
    !allowDowngrade &&
    Boolean(currentVersion && release.tag && compareVersions(currentVersion, release.tag) >= 0);

  if (dryRun) {
    const cdp = runCdpSetup({ setupCdp, cdpMode, dryRun: true, platformInfo: info, installations });
    return {
      updated: false,
      dryRun: true,
      alreadyLatest,
      tag: release.tag,
      currentVersion,
      version: currentVersion || release.tag,
      pluginDir,
      cdp,
      needsResign: Boolean(cdp && cdp.needsResign),
      appBundlePath: (cdp && cdp.appBundlePath) || null
    };
  }

  if (alreadyLatest) {
    const cdp = runCdpSetup({ setupCdp, cdpMode, dryRun: false, platformInfo: info, installations });
    return {
      updated: false,
      alreadyLatest: true,
      installed: true,
      tag: release.tag,
      currentVersion,
      version: currentVersion,
      pluginDir,
      cdp,
      needsResign: Boolean(cdp && cdp.needsResign),
      appBundlePath: (cdp && cdp.appBundlePath) || null
    };
  }

  const extractedDir = path.join(cacheDir, 'extracted');
  let capsuleDir = findCapsuleDir(extractedDir);

  if (!capsuleDir) {
    fs.rmSync(extractedDir, { recursive: true, force: true });

    let extracted = false;
    let lastError = null;

    if (release.tarballUrl) {
      try {
        const archivePath = path.join(cacheDir, 'source.tar.gz');
        await downloadFile(release.tarballUrl, archivePath, { env });
        await extractTarGz(archivePath, extractedDir);
        extracted = true;
      } catch (error) {
        lastError = error;
        fs.rmSync(extractedDir, { recursive: true, force: true });
      }
    }

    if (!extracted && release.zipballUrl) {
      const archivePath = path.join(cacheDir, 'source.zip');
      await downloadFile(release.zipballUrl, archivePath, { env });
      await extractZip(archivePath, extractedDir);
      extracted = true;
    }

    if (!extracted) {
      if (lastError) throw lastError;
      throw new Error(`Release ${release.tag} of ${UPSTREAM_REPO} has no tarball or zipball`);
    }

    capsuleDir = findCapsuleDir(extractedDir);
  }

  if (!capsuleDir) {
    throw new Error(`Could not find agy-capsule/plugin.json in ${UPSTREAM_REPO} release ${release.tag}`);
  }

  const installResult = installCapsule({
    sourceDir: capsuleDir,
    pluginsDir,
    setupCdp,
    cdpMode,
    dryRun: false,
    allowDowngrade,
    platformInfo: info,
    installations,
    env
  });

  return { updated: true, tag: release.tag, method: 'online', ...installResult };
}
