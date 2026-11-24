// Isolated tests for lib/modules/capsule.mjs. A temp pluginsDir and a temp
// realUserHome are always supplied, and setupCdp stays false so neither the
// real /Applications nor the real ~/.gemini is ever touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getCapsuleStatus,
  installCapsule,
  uninstallCapsule
} from '../lib/modules/capsule.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLED_DIR = path.join(REPO_ROOT, 'modules', 'capsule', 'agy-capsule');
const BUNDLED_VERSION = JSON.parse(
  fs.readFileSync(path.join(BUNDLED_DIR, 'plugin.json'), 'utf8')
).version;

const EMPTY_INSTALLATIONS = {
  desktop: [],
  ide: [],
  cli: [],
  primaryDesktop: null,
  primaryIde: null,
  allTargets: []
};

function makeSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-aio-capsule-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });

  return {
    root,
    home,
    pluginsDir: path.join(root, 'plugins'),
    settingsPath: path.join(home, '.gemini', 'config', 'agy-capsule', 'settings.json'),
    platformInfo: {
      os: process.platform,
      arch: process.arch,
      isRoot: false,
      realUserHome: home,
      dataDir: path.join(home, '.agy-aio')
    }
  };
}

test('getCapsuleStatus reports not installed and the bundled version', t => {
  const box = makeSandbox(t);

  const status = getCapsuleStatus({
    pluginsDir: box.pluginsDir,
    platformInfo: box.platformInfo,
    installations: EMPTY_INSTALLATIONS
  });

  assert.equal(status.installed, false);
  assert.equal(status.bundledVersion, BUNDLED_VERSION);
  assert.equal(status.installedVersion, null);
  assert.equal(status.pluginDir, path.join(box.pluginsDir, 'agy-capsule'));
  assert.equal(status.settingsExists, false);
});

test('installCapsule with dryRun writes nothing', t => {
  const box = makeSandbox(t);
  const pluginDir = path.join(box.pluginsDir, 'agy-capsule');

  const result = installCapsule({
    pluginsDir: box.pluginsDir,
    setupCdp: false,
    dryRun: true,
    platformInfo: box.platformInfo,
    installations: EMPTY_INSTALLATIONS
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.installed, false);
  assert.equal(fs.existsSync(pluginDir), false);
  assert.equal(fs.existsSync(box.pluginsDir), false);
});

test('installCapsule copies the plugin and clears the update marker', t => {
  const box = makeSandbox(t);
  const pluginDir = path.join(box.pluginsDir, 'agy-capsule');

  const result = installCapsule({
    pluginsDir: box.pluginsDir,
    setupCdp: false,
    platformInfo: box.platformInfo,
    installations: EMPTY_INSTALLATIONS
  });

  assert.equal(result.installed, true);
  assert.ok(fs.existsSync(path.join(pluginDir, 'plugin.json')));
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8')),
    JSON.parse(fs.readFileSync(path.join(BUNDLED_DIR, 'plugin.json'), 'utf8'))
  );
  assert.ok(fs.existsSync(path.join(pluginDir, 'sidecars')));
  assert.ok(fs.existsSync(path.join(pluginDir, 'sidecars', 'agy_capsule', 'server.mjs')));
  assert.equal(fs.existsSync(path.join(pluginDir, '.update-in-progress')), false);

  const status = getCapsuleStatus({
    pluginsDir: box.pluginsDir,
    platformInfo: box.platformInfo,
    installations: EMPTY_INSTALLATIONS
  });
  assert.equal(status.installed, true);
  assert.equal(status.installedVersion, BUNDLED_VERSION);
  assert.equal(status.bundledVersion, BUNDLED_VERSION);
});

test('installCapsule and uninstallCapsule refuse a symlinked plugin dir', t => {
  const box = makeSandbox(t);
  fs.mkdirSync(box.pluginsDir, { recursive: true });
  const target = path.join(box.root, 'real-target');
  fs.mkdirSync(target, { recursive: true });
  fs.symlinkSync(target, path.join(box.pluginsDir, 'agy-capsule'), 'dir');

  assert.throws(
    () =>
      installCapsule({
        pluginsDir: box.pluginsDir,
        setupCdp: false,
        platformInfo: box.platformInfo,
        installations: EMPTY_INSTALLATIONS
      }),
    /symlink/i
  );

  assert.throws(
    () =>
      uninstallCapsule({
        pluginsDir: box.pluginsDir,
        platformInfo: box.platformInfo,
        installations: EMPTY_INSTALLATIONS
      }),
    /symlink/i
  );
});

test('uninstallCapsule removes the plugin but preserves user settings', t => {
  const box = makeSandbox(t);
  const pluginDir = path.join(box.pluginsDir, 'agy-capsule');

  installCapsule({
    pluginsDir: box.pluginsDir,
    setupCdp: false,
    platformInfo: box.platformInfo,
    installations: EMPTY_INSTALLATIONS
  });
  assert.ok(fs.existsSync(pluginDir));

  fs.mkdirSync(path.dirname(box.settingsPath), { recursive: true });
  const settings = '{"theme":"dark"}\n';
  fs.writeFileSync(box.settingsPath, settings);

  const result = uninstallCapsule({
    pluginsDir: box.pluginsDir,
    platformInfo: box.platformInfo,
    installations: EMPTY_INSTALLATIONS
  });

  assert.equal(result.removed, true);
  assert.equal(result.settingsPreserved, true);
  assert.equal(fs.existsSync(pluginDir), false);
  assert.equal(fs.readFileSync(box.settingsPath, 'utf8'), settings);

  const status = getCapsuleStatus({
    pluginsDir: box.pluginsDir,
    platformInfo: box.platformInfo,
    installations: EMPTY_INSTALLATIONS
  });
  assert.equal(status.installed, false);
  assert.equal(status.settingsExists, true);
});
