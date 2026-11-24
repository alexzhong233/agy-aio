// Isolated tests for the native CDP launcher paths in lib/launcher.mjs and the
// cdpMode plumbing in lib/modules/capsule.mjs. Every test runs inside a temp
// root with a synthetic darwin platformInfo, so neither /Applications, the real
// ~/Applications, ~/.gemini nor ~/.agy-aio is ever touched. `codesign` and
// `osacompile` are replaced with no-op shims for the same reason.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getCdpStatus,
  hasCdpLauncherMarker,
  isNativeCdpPatched,
  setupCdpLauncher
} from '../lib/launcher.mjs';
import { installCapsule, uninstallCapsule } from '../lib/modules/capsule.mjs';

const MARKER = 'agy-aio-cdp-launcher';
const ORIGINAL_V1 = 'ORIGINAL_BINARY_V1';
const ORIGINAL_V2 = 'ORIGINAL_BINARY_V2';
const LAUNCHER_CONTENT = `#!/bin/sh\n# ${MARKER}\n`;
const WRAPPER_APP = 'Antigravity-CDP.app';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function makeWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-aio-cdp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const home = path.join(root, 'home');
  const dataDir = path.join(home, '.agy-aio');
  const appsDir = path.join(root, 'Applications');
  const appBundlePath = path.join(appsDir, 'Antigravity.app');
  const exePath = path.join(appBundlePath, 'Contents', 'MacOS', 'Antigravity');
  const launcherBinPath = path.join(root, 'bin', 'agy-cdp-launcher');

  fs.mkdirSync(path.dirname(exePath), { recursive: true });
  fs.mkdirSync(path.join(home, 'Applications'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.dirname(launcherBinPath), { recursive: true });

  fs.writeFileSync(exePath, ORIGINAL_V1, { mode: 0o755 });
  fs.chmodSync(exePath, 0o755);

  fs.writeFileSync(launcherBinPath, LAUNCHER_CONTENT, { mode: 0o755 });
  fs.chmodSync(launcherBinPath, 0o755);

  return {
    root,
    home,
    dataDir,
    appsDir,
    appBundlePath,
    exePath,
    launcherBinPath,
    installations: { exePath, appBundlePath },
    platformInfo: {
      os: 'darwin',
      arch: 'arm64',
      isRoot: false,
      realUserHome: home,
      dataDir,
      applicationsDir: appsDir
    }
  };
}

// The darwin code paths shell out to `codesign` and `osacompile` even when the
// host is not macOS. Prepend shims so dummy fixtures never reach the real
// toolchain: codesign is a no-op and osacompile creates the directory named
// after `-o` (which is all setupCdpLauncher checks afterwards).
function installShims(t, root) {
  const shimDir = path.join(root, 'shims');
  fs.mkdirSync(shimDir, { recursive: true });

  const codesign = path.join(shimDir, 'codesign');
  fs.writeFileSync(codesign, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(codesign, 0o755);

  const osacompile = path.join(shimDir, 'osacompile');
  fs.writeFileSync(
    osacompile,
    [
      '#!/bin/sh',
      'out=""',
      'while [ $# -gt 0 ]; do',
      '  if [ "$1" = "-o" ]; then out="$2"; shift 2; continue; fi',
      '  shift',
      'done',
      'if [ -n "$out" ]; then mkdir -p "$out"; fi',
      'exit 0',
      ''
    ].join('\n')
  );
  fs.chmodSync(osacompile, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${shimDir}${path.delimiter}${previousPath ?? ''}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
}

function cdpStatus(ws) {
  return getCdpStatus({ platformInfo: ws.platformInfo, installations: ws.installations });
}

/* ------------------------------------------------------------------ *
 * hasCdpLauncherMarker
 * ------------------------------------------------------------------ */

test('hasCdpLauncherMarker returns false for empty, missing, directory and unmarked paths', t => {
  const ws = makeWorkspace(t);

  assert.equal(hasCdpLauncherMarker(''), false);
  assert.equal(hasCdpLauncherMarker(path.join(ws.root, 'missing-binary')), false);
  assert.equal(hasCdpLauncherMarker(ws.appsDir), false);

  const empty = path.join(ws.root, 'empty.bin');
  fs.writeFileSync(empty, '');
  assert.equal(hasCdpLauncherMarker(empty), false);

  const normal = path.join(ws.root, 'normal-binary');
  fs.writeFileSync(normal, ORIGINAL_V1);
  assert.equal(hasCdpLauncherMarker(normal), false);
});

test('hasCdpLauncherMarker finds the marker in a small launcher file', t => {
  const ws = makeWorkspace(t);

  assert.equal(hasCdpLauncherMarker(ws.launcherBinPath), true);
});

test('hasCdpLauncherMarker scans past the first Mach-O slice (32 KB, marker at 20 KB)', t => {
  const ws = makeWorkspace(t);
  const universal = path.join(ws.root, 'cdp-universal');

  const buf = Buffer.alloc(32 * 1024, 0);
  buf.write(MARKER, 20 * 1024, 'utf8');
  fs.writeFileSync(universal, buf);

  assert.equal(hasCdpLauncherMarker(universal), true);
});

/* ------------------------------------------------------------------ *
 * Native install / status
 * ------------------------------------------------------------------ */

test('setupCdpLauncher native dryRun reports the plan and writes nothing', t => {
  const ws = makeWorkspace(t);
  installShims(t, ws.root);

  const result = setupCdpLauncher({
    mode: 'native',
    launcherBinPath: ws.launcherBinPath,
    dryRun: true,
    platformInfo: ws.platformInfo,
    installations: ws.installations
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.configured, false);
  assert.equal(result.mode, 'native');
  assert.equal(result.needsResign, true);
  assert.equal(result.appBundlePath, ws.appBundlePath);
  assert.equal(result.exePath, ws.exePath);

  assert.equal(fs.readFileSync(ws.exePath, 'utf8'), ORIGINAL_V1);
  assert.equal(fs.existsSync(`${ws.exePath}.orig`), false);
});

test('setupCdpLauncher native backs up the binary and clears existing wrappers', t => {
  const ws = makeWorkspace(t);
  installShims(t, ws.root);

  const staleSystemWrapper = path.join(ws.appsDir, WRAPPER_APP);
  const staleUserWrapper = path.join(ws.home, 'Applications', WRAPPER_APP);
  fs.mkdirSync(path.join(staleSystemWrapper, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(staleSystemWrapper, 'Contents', 'Info.plist'), 'stale');
  fs.mkdirSync(path.join(staleUserWrapper, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(staleUserWrapper, 'Contents', 'Info.plist'), 'stale');

  const result = setupCdpLauncher({
    mode: 'native',
    launcherBinPath: ws.launcherBinPath,
    platformInfo: ws.platformInfo,
    installations: ws.installations
  });

  assert.equal(result.configured, true);
  assert.equal(result.mode, 'native');
  assert.equal(result.needsResign, true);
  assert.equal(result.exePath, ws.exePath);
  assert.equal(result.origPath, `${ws.exePath}.orig`);
  assert.deepEqual(result.launchers, [ws.exePath]);

  assert.equal(fs.readFileSync(`${ws.exePath}.orig`, 'utf8'), ORIGINAL_V1);
  assert.equal(hasCdpLauncherMarker(ws.exePath), true);
  assert.equal(fs.existsSync(staleSystemWrapper), false);
  assert.equal(fs.existsSync(staleUserWrapper), false);

  assert.equal(isNativeCdpPatched(ws.exePath), true);

  const status = cdpStatus(ws);
  assert.equal(status.supported, true);
  assert.equal(status.configured, true);
  assert.equal(status.mode, 'native');
  assert.equal(status.nativePatched, true);
  assert.equal(status.wrapperConfigured, false);
  assert.deepEqual(status.launchers, [ws.exePath]);
  assert.equal(status.exePath, ws.exePath);
});

test('native install refreshes a stale .orig after an official update', t => {
  const ws = makeWorkspace(t);
  installShims(t, ws.root);

  const native = () =>
    setupCdpLauncher({
      mode: 'native',
      launcherBinPath: ws.launcherBinPath,
      platformInfo: ws.platformInfo,
      installations: ws.installations
    });

  assert.equal(native().configured, true);
  assert.equal(fs.readFileSync(`${ws.exePath}.orig`, 'utf8'), ORIGINAL_V1);

  // The official updater replaced the live binary; the stale .orig must not
  // make the app look patched.
  fs.writeFileSync(ws.exePath, ORIGINAL_V2);
  assert.equal(isNativeCdpPatched(ws.exePath), false);

  let status = cdpStatus(ws);
  assert.equal(status.configured, false);
  assert.equal(status.mode, 'none');
  assert.equal(status.nativePatched, false);
  assert.equal(status.wrapperConfigured, false);
  assert.deepEqual(status.launchers, []);
  assert.equal(fs.readFileSync(`${ws.exePath}.orig`, 'utf8'), ORIGINAL_V1);

  // A refresh replaces the stale backup and re-installs the launcher.
  const refreshed = native();
  assert.equal(refreshed.configured, true);
  assert.equal(fs.readFileSync(`${ws.exePath}.orig`, 'utf8'), ORIGINAL_V2);
  assert.equal(hasCdpLauncherMarker(ws.exePath), true);

  status = cdpStatus(ws);
  assert.equal(status.mode, 'native');
  assert.equal(status.nativePatched, true);
});

/* ------------------------------------------------------------------ *
 * Mode transitions and undo
 * ------------------------------------------------------------------ */

test('native -> wrapper restores the binary and creates Antigravity-CDP.app', t => {
  const ws = makeWorkspace(t);
  installShims(t, ws.root);

  const native = () =>
    setupCdpLauncher({
      mode: 'native',
      launcherBinPath: ws.launcherBinPath,
      platformInfo: ws.platformInfo,
      installations: ws.installations
    });

  native();
  fs.writeFileSync(ws.exePath, ORIGINAL_V2);
  native(); // refresh so .orig holds ORIGINAL_V2

  const wrapperPath = path.join(ws.appsDir, WRAPPER_APP);
  const result = setupCdpLauncher({
    mode: 'wrapper',
    platformInfo: ws.platformInfo,
    installations: ws.installations
  });

  assert.equal(result.configured, true);
  assert.equal(result.mode, 'wrapper');
  assert.equal(result.needsResign, true);
  assert.equal(result.targetPath, wrapperPath);
  assert.equal(result.appPath, wrapperPath);
  assert.equal(result.appBundlePath, ws.appBundlePath);

  assert.equal(fs.readFileSync(ws.exePath, 'utf8'), ORIGINAL_V2);
  assert.equal(fs.existsSync(`${ws.exePath}.orig`), false);
  assert.equal(fs.existsSync(wrapperPath), true);

  const status = cdpStatus(ws);
  assert.equal(status.configured, true);
  assert.equal(status.mode, 'wrapper');
  assert.equal(status.nativePatched, false);
  assert.equal(status.wrapperConfigured, true);
  assert.deepEqual(status.launchers, [wrapperPath]);
});

test('wrapper -> none removes the wrapper and leaves the original binary', t => {
  const ws = makeWorkspace(t);
  installShims(t, ws.root);

  setupCdpLauncher({
    mode: 'native',
    launcherBinPath: ws.launcherBinPath,
    platformInfo: ws.platformInfo,
    installations: ws.installations
  });
  setupCdpLauncher({
    mode: 'wrapper',
    platformInfo: ws.platformInfo,
    installations: ws.installations
  });
  assert.equal(cdpStatus(ws).mode, 'wrapper');

  const result = setupCdpLauncher({
    mode: 'none',
    platformInfo: ws.platformInfo,
    installations: ws.installations
  });

  assert.equal(result.configured, false);
  assert.equal(result.mode, 'none');
  assert.equal(result.undone, true);
  assert.equal(fs.readFileSync(ws.exePath, 'utf8'), ORIGINAL_V1);
  assert.equal(fs.existsSync(`${ws.exePath}.orig`), false);
  assert.equal(fs.existsSync(path.join(ws.appsDir, WRAPPER_APP)), false);

  const status = cdpStatus(ws);
  assert.equal(status.configured, false);
  assert.equal(status.mode, 'none');
  assert.equal(status.nativePatched, false);
  assert.equal(status.wrapperConfigured, false);
  assert.deepEqual(status.launchers, []);
});

test('native -> undo restores the original binary and deletes the backup', t => {
  const ws = makeWorkspace(t);
  installShims(t, ws.root);

  setupCdpLauncher({
    mode: 'native',
    launcherBinPath: ws.launcherBinPath,
    platformInfo: ws.platformInfo,
    installations: ws.installations
  });
  assert.equal(isNativeCdpPatched(ws.exePath), true);

  const result = setupCdpLauncher({
    undo: true,
    platformInfo: ws.platformInfo,
    installations: ws.installations
  });

  assert.equal(result.configured, false);
  assert.equal(result.mode, 'none');
  assert.equal(result.undone, true);
  assert.equal(result.needsResign, true);
  assert.equal(result.restoredNative.restored, true);
  assert.equal(fs.readFileSync(ws.exePath, 'utf8'), ORIGINAL_V1);
  assert.equal(fs.existsSync(`${ws.exePath}.orig`), false);
  assert.equal(isNativeCdpPatched(ws.exePath), false);

  const status = cdpStatus(ws);
  assert.equal(status.configured, false);
  assert.equal(status.mode, 'none');
  assert.equal(status.nativePatched, false);
  assert.equal(status.wrapperConfigured, false);
});

test('setupCdpLauncher rejects an unsupported mode with a TypeError', t => {
  const ws = makeWorkspace(t);

  assert.throws(
    () =>
      setupCdpLauncher({
        mode: 'sidecar',
        platformInfo: ws.platformInfo,
        installations: ws.installations
      }),
    TypeError
  );
  assert.equal(fs.readFileSync(ws.exePath, 'utf8'), ORIGINAL_V1);
});

/* ------------------------------------------------------------------ *
 * Capsule install / uninstall with cdpMode: 'native'
 * ------------------------------------------------------------------ */

test('installCapsule and uninstallCapsule drive the native CDP launcher', t => {
  const ws = makeWorkspace(t);
  installShims(t, ws.root);

  const pluginsDir = path.join(ws.root, 'plugins');
  const pluginDir = path.join(pluginsDir, 'agy-capsule');

  // Cached launcher (getCdpLauncherPaths falls back to dataDir/bin when the
  // repo checkout has no built artifact). It carries the marker either way.
  const cacheBin = path.join(ws.dataDir, 'bin', 'agy-cdp-launcher');
  fs.writeFileSync(cacheBin, LAUNCHER_CONTENT, { mode: 0o755 });
  fs.chmodSync(cacheBin, 0o755);

  const installed = installCapsule({
    pluginsDir,
    cdpMode: 'native',
    platformInfo: ws.platformInfo,
    installations: ws.installations
  });

  assert.equal(installed.installed, true);
  assert.ok(fs.existsSync(path.join(pluginDir, 'plugin.json')));
  assert.equal(installed.cdp.mode, 'native');
  assert.equal(installed.cdp.configured, true);
  assert.equal(installed.needsResign, true);
  assert.equal(installed.appBundlePath, ws.appBundlePath);

  assert.equal(fs.readFileSync(`${ws.exePath}.orig`, 'utf8'), ORIGINAL_V1);
  assert.equal(hasCdpLauncherMarker(ws.exePath), true);
  assert.equal(isNativeCdpPatched(ws.exePath), true);
  assert.equal(cdpStatus(ws).mode, 'native');

  const uninstalled = uninstallCapsule({
    pluginsDir,
    undoCdp: true,
    platformInfo: ws.platformInfo,
    installations: ws.installations
  });

  assert.equal(uninstalled.removed, true);
  assert.equal(fs.existsSync(pluginDir), false);
  assert.equal(uninstalled.needsResign, true);
  assert.equal(uninstalled.appBundlePath, ws.appBundlePath);

  assert.equal(fs.readFileSync(ws.exePath, 'utf8'), ORIGINAL_V1);
  assert.equal(fs.existsSync(`${ws.exePath}.orig`), false);
  assert.equal(isNativeCdpPatched(ws.exePath), false);

  const status = cdpStatus(ws);
  assert.equal(status.configured, false);
  assert.equal(status.mode, 'none');
  assert.equal(status.nativePatched, false);
  assert.equal(status.wrapperConfigured, false);
});
