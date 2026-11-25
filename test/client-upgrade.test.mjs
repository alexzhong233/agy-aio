// Isolated tests for lib/modules/client-upgrade.mjs.
//
// Every writable path lives under a per-test mkdtemp directory. Platform data
// is supplied explicitly through `platformInfo` / `installations` / `env`, so
// the real /Applications/Antigravity.app, ~/Library/Caches and ~/.agy-aio are
// never read or written. Remote manifests are served by a local fetchImpl.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  parseSimpleYaml,
  getManifestFileName,
  getPendingUpdate,
  getClientUpdateStatus,
  upgradeClient
} from '../lib/modules/client-upgrade.mjs';
import { sha512Base64File, verifySha512Base64 } from '../lib/net.mjs';
import { signBinaryAdhoc, resignAppBundle } from '../lib/codesign.mjs';

function makeTemp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-aio-upgrade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makePlatformInfo(root, osName = 'darwin', arch = process.arch) {
  return {
    os: osName,
    arch,
    realUserHome: root,
    dataDir: path.join(root, '.agy-aio'),
    isRoot: false,
    realUid: null,
    realGid: null
  };
}

function makeDesktop(appBundlePath) {
  const resourcesDir = path.join(appBundlePath, 'Contents', 'Resources');
  const asarPath = path.join(resourcesDir, 'app.asar');
  return {
    kind: 'desktop',
    name: 'Antigravity Desktop',
    rootDir: appBundlePath,
    exePath: path.join(appBundlePath, 'Contents', 'MacOS', 'Antigravity'),
    resourcesDir,
    asarPath,
    backupAsarPath: `${asarPath}.bak`,
    languageServers: [],
    cliBinPath: null,
    appBundlePath
  };
}

function makeInstallations(desktop) {
  return {
    desktop: [desktop],
    ide: [],
    cli: [],
    primaryDesktop: desktop,
    primaryIde: null,
    allTargets: [desktop]
  };
}

function makeEnv(cacheDir) {
  return { ...process.env, AGY_AIO_UPDATER_CACHE_DIR: cacheDir };
}

function plist(version, extra = '') {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    '<key>CFBundleIdentifier</key><string>com.google.antigravity.test</string>',
    `<key>CFBundleShortVersionString</key><string>${version}</string>`,
    extra,
    '</dict></plist>',
    ''
  ].join('\n');
}

function writeAppBundle(parent, name, version, { marker = false, symlink = false } = {}) {
  const app = path.join(parent, name);
  const contents = path.join(app, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), plist(version), 'utf8');

  const exe = path.join(contents, 'MacOS', 'Antigravity');
  fs.writeFileSync(exe, '#!/bin/sh\nexit 0\n', 'utf8');
  fs.chmodSync(exe, 0o755);

  if (marker) fs.writeFileSync(path.join(contents, 'old-marker.txt'), 'old', 'utf8');
  if (symlink) {
    const versions = path.join(contents, 'Frameworks', 'Test.framework', 'Versions');
    fs.mkdirSync(path.join(versions, 'A', 'Bin'), { recursive: true });
    fs.writeFileSync(path.join(versions, 'A', 'Bin', 'dummy.txt'), 'keep', 'utf8');
    fs.symlinkSync('A', path.join(versions, 'Current'));
  }
  return app;
}

function manifestYaml({ version, sha512, size, fileName = 'Antigravity.zip' }) {
  const url = `https://example.invalid/${fileName}`;
  return [
    `version: ${version}`,
    `path: ${url}`,
    `sha512: ${sha512}`,
    'files:',
    `  - url: ${url}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    ''
  ].join('\n');
}

// A fetchImpl that answers the manifest request locally and (optionally)
// serves a tampered payload for the download URL. No real network is used.
function makeManifestFetch({ version, sha512, size, urls = [], body = null }) {
  const yaml = manifestYaml({ version, sha512, size });
  return async (url, _opts = {}) => {
    urls.push(String(url));
    if (String(url).toLowerCase().endsWith('.zip')) {
      return {
        ok: true,
        status: 200,
        body: null,
        arrayBuffer: async () => Buffer.from(body ?? 'downloaded bytes')
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => yaml
    };
  };
}

function writePending(cacheDir, { fileName, sha512, size }) {
  const pendingDir = path.join(cacheDir, 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(
    path.join(pendingDir, 'update-info.json'),
    `${JSON.stringify({ fileName, sha512, size })}\n`,
    'utf8'
  );
  return pendingDir;
}

/* ------------------------------------------------------------------ *
 * 1. Manifest parsing / platform mapping
 * ------------------------------------------------------------------ */

test('parseSimpleYaml handles CRLF and LF electron-builder manifests', () => {
  const win = [
    'version: 2.35.1',
    'path: https://example.invalid/Antigravity.exe',
    'sha512: winTopDigest==',
    'files:',
    '  - url: https://example.invalid/Antigravity.exe',
    '    sha512: winFileDigest==',
    '    size: 226492416',
    ''
  ].join('\r\n');
  const parsedWin = parseSimpleYaml(win);
  assert.equal(parsedWin.version, '2.35.1');
  assert.equal(parsedWin.path, 'https://example.invalid/Antigravity.exe');
  assert.equal(parsedWin.sha512, 'winTopDigest==');
  assert.equal(parsedWin.files.length, 1);
  assert.equal(parsedWin.files[0].sha512, 'winFileDigest==');
  assert.equal(parsedWin.files[0].size, 226492416);
  assert.equal(typeof parsedWin.files[0].size, 'number');

  const mac = [
    'version: 2.35.1',
    'path: https://example.invalid/Antigravity.zip',
    'sha512: macTopDigest==',
    'files:',
    '  - url: https://example.invalid/Antigravity.zip',
    '    sha512: macFileDigest==',
    '    size: 123456789',
    ''
  ].join('\n');
  const parsedMac = parseSimpleYaml(mac);
  assert.equal(parsedMac.version, '2.35.1');
  assert.equal(parsedMac.path, 'https://example.invalid/Antigravity.zip');
  assert.equal(parsedMac.sha512, 'macTopDigest==');
  assert.equal(parsedMac.files.length, 1);
  assert.equal(parsedMac.files[0].sha512, 'macFileDigest==');
  assert.equal(parsedMac.files[0].size, 123456789);
  assert.equal(typeof parsedMac.files[0].size, 'number');

  const linux = [
    'version: 2.35.1',
    'path: https://example.invalid/Antigravity.AppImage',
    'files:',
    '  - url: https://example.invalid/Antigravity-x64.AppImage',
    '    sha512: x64Digest==',
    '    size: 111',
    '  - url: https://example.invalid/Antigravity-arm64.AppImage',
    '    sha512: arm64Digest==',
    '    size: 222',
    '  - url: https://example.invalid/Antigravity.deb',
    '    sha512: debDigest==',
    '    size: 333',
    ''
  ].join('\n');
  const parsedLinux = parseSimpleYaml(linux);
  assert.equal(parsedLinux.version, '2.35.1');
  assert.equal(parsedLinux.path, 'https://example.invalid/Antigravity.AppImage');
  assert.equal(parsedLinux.files.length, 3);
  assert.deepEqual(
    parsedLinux.files.map(file => file.size),
    [111, 222, 333]
  );
  assert.ok(parsedLinux.files.every(file => typeof file.size === 'number'));
  assert.equal(parsedLinux.files[2].sha512, 'debDigest==');
});

test('getManifestFileName maps supported platforms and rejects unknown ones', () => {
  assert.equal(getManifestFileName({ os: 'darwin', arch: 'arm64' }), 'latest-arm64-mac.yml');
  assert.equal(getManifestFileName({ os: 'win32', arch: 'x64' }), 'latest-x64-win.yml');
  assert.equal(getManifestFileName({ os: 'linux', arch: 'x64' }), 'latest-x64-linux.yml');
  assert.equal(getManifestFileName({ os: 'freebsd', arch: 'x64' }), null);
});

/* ------------------------------------------------------------------ *
 * 2. Pending update discovery
 * ------------------------------------------------------------------ */

test('getPendingUpdate reports a staged package and contains path traversal', async t => {
  const root = makeTemp(t);
  const cacheDir = path.join(root, 'cache');
  const info = makePlatformInfo(root);
  const installations = makeInstallations(makeDesktop(path.join(root, 'Antigravity.app')));
  const env = makeEnv(cacheDir);

  const bytes = Buffer.from('staged package bytes');
  const sha512 = await sha512Base64File(
    (() => {
      const file = path.join(root, 'payload.bin');
      fs.writeFileSync(file, bytes);
      return file;
    })()
  );
  const pendingDir = writePending(cacheDir, {
    fileName: 'Antigravity.zip',
    sha512,
    size: bytes.length
  });
  fs.writeFileSync(path.join(pendingDir, 'Antigravity.zip'), bytes);

  const pending = getPendingUpdate({ platformInfo: info, installations, env });
  assert.equal(pending.exists, true);
  assert.equal(pending.fileName, 'Antigravity.zip');
  assert.equal(pending.filePath, path.join(pendingDir, 'Antigravity.zip'));
  assert.equal(pending.sha512, sha512);
  assert.equal(pending.size, bytes.length);

  // A traversal in update-info.json must never resolve outside pendingDir.
  const outside = path.join(root, 'outside.zip');
  fs.writeFileSync(outside, 'do not read me');
  writePending(cacheDir, { fileName: '../../outside.zip', sha512, size: bytes.length });
  const traversed = getPendingUpdate({ platformInfo: info, installations, env });
  assert.equal(traversed.fileName, 'outside.zip');
  assert.equal(traversed.filePath, path.join(pendingDir, 'outside.zip'));
  assert.equal(path.dirname(traversed.filePath), pendingDir);
  assert.equal(traversed.exists, false);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'do not read me');

  for (const badName of ['.', '..', '   ']) {
    writePending(cacheDir, { fileName: badName, sha512, size: bytes.length });
    const bad = getPendingUpdate({ platformInfo: info, installations, env });
    assert.equal(bad.exists, false);
    assert.equal(bad.fileName, null);
  }
});

/* ------------------------------------------------------------------ *
 * 3. SHA-512 verification
 * ------------------------------------------------------------------ */

test('verifySha512Base64 accepts only the exact base64 digest', async t => {
  const root = makeTemp(t);
  const file = path.join(root, 'payload.bin');
  fs.writeFileSync(file, Buffer.from('hello sha512'));

  const digest = await sha512Base64File(file);
  assert.equal(digest.length, 88);

  assert.equal((await verifySha512Base64(file, digest)).ok, true);
  assert.equal((await verifySha512Base64(file, Buffer.from('wrong').toString('base64'))).ok, false);
  assert.equal((await verifySha512Base64(file, '')).ok, false);
});

/* ------------------------------------------------------------------ *
 * 4. Status with a mocked remote manifest
 * ------------------------------------------------------------------ */

test('getClientUpdateStatus merges a remote manifest with a verified pending package', async t => {
  const root = makeTemp(t);
  const cacheDir = path.join(root, 'cache');
  const app = writeAppBundle(root, 'Antigravity.app', '2.34.0');
  const pendingDir = path.join(cacheDir, 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });

  const zip = path.join(pendingDir, 'Antigravity.zip');
  fs.writeFileSync(zip, Buffer.from('fake pending package'));
  const digest = await sha512Base64File(zip);
  writePending(cacheDir, { fileName: 'Antigravity.zip', sha512: digest, size: fs.statSync(zip).size });

  const base = {
    platformInfo: makePlatformInfo(root),
    installations: makeInstallations(makeDesktop(app)),
    env: makeEnv(cacheDir),
    checkRemote: true
  };
  const urls = [];
  const status = await getClientUpdateStatus({
    ...base,
    fetchImpl: makeManifestFetch({ version: '2.35.1', sha512: digest, size: 1234, urls })
  });

  assert.equal(status.clientVersion, '2.34.0');
  assert.equal(status.latestVersion, '2.35.1');
  assert.equal(status.updateAvailable, true);
  assert.equal(status.pendingAvailable, true);
  assert.equal(status.pendingMatchesLatest, true);
  assert.equal(status.pendingUpdate.exists, true);
  assert.equal(status.pendingUpdate.fileName, 'Antigravity.zip');
  assert.equal(urls.length, 1);
  assert.match(urls[0], /latest-[^/]+-mac\.yml$/);

  const offline = await getClientUpdateStatus({
    ...base,
    fetchImpl: async () => {
      throw new Error('offline test');
    }
  });
  assert.match(offline.remoteError, /offline test/);
  assert.equal(offline.latestVersion, null);
  assert.equal(offline.pendingUpdate.exists, true);
  assert.equal(offline.pendingUpdate.fileName, 'Antigravity.zip');
  assert.equal(offline.pendingAvailable, true);
});

/* ------------------------------------------------------------------ *
 * 5. Isolated macOS swap (symlinks, cache cleanup, beforeSwap)
 * ------------------------------------------------------------------ */

test('upgradeClient swaps a pending macOS package and cleans stale cache', async t => {
  if (process.platform !== 'darwin') return t.skip('macOS only');

  const root = makeTemp(t);
  const cacheDir = path.join(root, 'updater-cache');
  const shipItDir = `${cacheDir}.ShipIt`;
  const pendingDir = path.join(cacheDir, 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.mkdirSync(shipItDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'update.zip'), 'stale cached update');
  fs.writeFileSync(path.join(shipItDir, 'stale.txt'), 'stale shipit entry');

  const fixtureRoot = path.join(root, 'fixture');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const newApp = writeAppBundle(fixtureRoot, 'Antigravity.app', '2.35.1', { symlink: true });
  const zipPath = path.join(root, 'Antigravity-2.35.1.zip');
  execFileSync('ditto', ['-c', '-k', '--keepParent', newApp, zipPath]);
  const digest = await sha512Base64File(zipPath);
  const size = fs.statSync(zipPath).size;

  fs.copyFileSync(zipPath, path.join(pendingDir, 'Antigravity.zip'));
  writePending(cacheDir, { fileName: 'Antigravity.zip', sha512: digest, size });

  const installed = writeAppBundle(root, 'Antigravity.app', '2.34.0', { marker: true });
  const calls = [];
  const urls = [];
  const result = await upgradeClient({
    platformInfo: makePlatformInfo(root),
    installations: makeInstallations(makeDesktop(installed)),
    env: makeEnv(cacheDir),
    skipSignatureCheck: true,
    beforeSwap: async ctx => {
      calls.push(ctx);
      return true;
    },
    fetchImpl: makeManifestFetch({ version: '2.35.1', sha512: digest, size, urls })
  });

  assert.equal(result.upgraded, true);
  assert.equal(result.source, 'pending');
  assert.equal(result.previousVersion, '2.34.0');
  assert.equal(result.newVersion, '2.35.1');
  assert.equal(calls.length, 1);
  assert.deepEqual(
    {
      previousVersion: calls[0].previousVersion,
      newVersion: calls[0].newVersion,
      source: calls[0].source
    },
    { previousVersion: '2.34.0', newVersion: '2.35.1', source: 'pending' }
  );

  assert.equal(fs.existsSync(path.join(installed, 'Contents', 'old-marker.txt')), false);
  assert.match(fs.readFileSync(path.join(installed, 'Contents', 'Info.plist'), 'utf8'), /2\.35\.1/);

  const current = path.join(
    installed,
    'Contents',
    'Frameworks',
    'Test.framework',
    'Versions',
    'Current'
  );
  assert.equal(fs.lstatSync(current).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(current), 'A');
  assert.equal(fs.existsSync(path.join(current, 'Bin', 'dummy.txt')), true);

  assert.equal(fs.existsSync(path.join(pendingDir, 'update-info.json')), false);
  assert.equal(fs.existsSync(path.join(cacheDir, 'update.zip')), false);
  assert.deepEqual(fs.readdirSync(shipItDir), []);
});

/* ------------------------------------------------------------------ *
 * 6. dry-run safety and SHA-512 mismatch
 * ------------------------------------------------------------------ */

test('upgradeClient dry-run never downloads; a checksum mismatch aborts before beforeSwap', async t => {
  if (process.platform !== 'darwin') return t.skip('macOS only');

  const root = makeTemp(t);
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const installed = writeAppBundle(root, 'Antigravity.app', '2.34.0', { marker: true });
  const base = {
    platformInfo: makePlatformInfo(root),
    installations: makeInstallations(makeDesktop(installed)),
    env: makeEnv(cacheDir)
  };

  const goodFile = path.join(root, 'official.bin');
  fs.writeFileSync(goodFile, Buffer.from('official package bytes'));
  const goodDigest = await sha512Base64File(goodFile);

  const urls = [];
  let beforeSwapCalls = 0;
  const dry = await upgradeClient({
    ...base,
    dryRun: true,
    beforeSwap: async () => {
      beforeSwapCalls += 1;
      return true;
    },
    fetchImpl: makeManifestFetch({ version: '2.35.1', sha512: goodDigest, size: 4096, urls })
  });

  assert.equal(dry.upgraded, false);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.source, 'remote');
  assert.equal(dry.newVersion, '2.35.1');
  assert.equal(beforeSwapCalls, 0);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\.yml$/);

  const cachedPath = path.join(base.platformInfo.dataDir, 'cache', 'client', '2.35.1', 'Antigravity.zip');
  assert.equal(fs.existsSync(cachedPath), false);

  let tamperedCalls = 0;
  await assert.rejects(
    upgradeClient({
      ...base,
      beforeSwap: async () => {
        tamperedCalls += 1;
        return true;
      },
      fetchImpl: makeManifestFetch({
        version: '2.35.1',
        sha512: goodDigest,
        size: 4096,
        body: 'tampered download bytes'
      })
    }),
    /Downloaded package failed SHA-512 verification/
  );

  assert.equal(tamperedCalls, 0);
  assert.equal(fs.existsSync(path.join(installed, 'Contents', 'old-marker.txt')), true);
  assert.match(fs.readFileSync(path.join(installed, 'Contents', 'Info.plist'), 'utf8'), /2\.34\.0/);
});

/* ------------------------------------------------------------------ *
 * 7. Entitlements preservation (real codesign, macOS only)
 * ------------------------------------------------------------------ */

test('codesign helpers preserve an existing entitlement on macOS', t => {
  if (process.platform !== 'darwin') return t.skip('macOS only');

  const root = makeTemp(t);
  const app = path.join(root, 'Dummy.app');
  const contents = path.join(app, 'Contents');
  const bin = path.join(contents, 'MacOS', 'Dummy');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(
    path.join(contents, 'Info.plist'),
    plist(
      '1.0.0',
      '<key>CFBundlePackageType</key><string>APPL</string>' +
        '<key>CFBundleExecutable</key><string>Dummy</string>'
    ),
    'utf8'
  );

  const source = path.join(root, 'dummy.c');
  fs.writeFileSync(source, 'int main(void){return 0;}\n', 'utf8');
  try {
    execFileSync('cc', [source, '-o', bin], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (error && error.code === 'ENOENT') return t.skip('clang not available');
    throw error;
  }
  fs.chmodSync(bin, 0o755);

  const entitlementsPath = path.join(root, 'entitlements.plist');
  fs.writeFileSync(
    entitlementsPath,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '<key>com.apple.security.cs.allow-jit</key><true/>',
      '</dict></plist>',
      ''
    ].join('\n'),
    'utf8'
  );

  execFileSync('codesign', ['-f', '-s', '-', '--entitlements', entitlementsPath, bin], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  execFileSync('codesign', ['-f', '-s', '-', '--deep', '--entitlements', entitlementsPath, app], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const signed = signBinaryAdhoc(bin);
  assert.equal(signed.signed, true);
  const resigned = resignAppBundle(app);
  assert.equal(resigned.signed, true);
  assert.equal(resigned.entitlementsPreserved, true);

  let report = '';
  try {
    report = execFileSync(
      '/bin/sh',
      ['-c', 'codesign -d --entitlements - "$1" 2>&1', 'codesign', app],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (error) {
    report = [error && error.stdout, error && error.stderr].filter(Boolean).join('\n');
  }
  assert.match(report, /com\.apple\.security\.cs\.allow-jit/);
});

/* ------------------------------------------------------------------ *
 * 8. Official signature requirement
 * ------------------------------------------------------------------ */

test('upgradeClient refuses a non-Google-signed macOS package before beforeSwap', async t => {
  if (process.platform !== 'darwin') return t.skip('macOS only');

  const root = makeTemp(t);
  const cacheDir = path.join(root, 'cache');
  const pendingDir = path.join(cacheDir, 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });

  const fixtureRoot = path.join(root, 'fixture');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const newApp = writeAppBundle(fixtureRoot, 'Antigravity.app', '2.35.1');
  const zipPath = path.join(root, 'new.zip');
  execFileSync('ditto', ['-c', '-k', '--keepParent', newApp, zipPath]);
  const digest = await sha512Base64File(zipPath);
  const size = fs.statSync(zipPath).size;

  fs.copyFileSync(zipPath, path.join(pendingDir, 'Antigravity.zip'));
  writePending(cacheDir, { fileName: 'Antigravity.zip', sha512: digest, size });

  const installed = writeAppBundle(root, 'Antigravity.app', '2.34.0', { marker: true });
  let beforeSwapCalls = 0;

  await assert.rejects(
    upgradeClient({
      platformInfo: makePlatformInfo(root),
      installations: makeInstallations(makeDesktop(installed)),
      env: makeEnv(cacheDir),
      skipSignatureCheck: false,
      beforeSwap: async () => {
        beforeSwapCalls += 1;
        return true;
      },
      fetchImpl: makeManifestFetch({ version: '2.35.1', sha512: digest, size })
    }),
    /Official Google signature check failed/
  );

  assert.equal(beforeSwapCalls, 0);
  assert.equal(fs.existsSync(path.join(installed, 'Contents', 'old-marker.txt')), true);
  assert.match(fs.readFileSync(path.join(installed, 'Contents', 'Info.plist'), 'utf8'), /2\.34\.0/);
});
