// Isolated tests for the localization orchestration layer. Every test builds
// a fake Antigravity layout under a fresh mkdtemp directory; the real
// /Applications/Antigravity.app, ~/.gemini and ~/.agy-aio are never used.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  ensureOfficialBackup,
  evaluateLocalizationCompatibility,
  getLocalizationStatus,
  installLocalization,
  uninstallLocalization
} from '../lib/modules/localization.mjs';
import { parseSha256Sums, verifySha256Sums } from '../lib/net.mjs';

const require = createRequire(import.meta.url);
const { readAsarPackageVersion } = require('../modules/localization/asar-version.js');
const { isLocalizedAsar } = require('../modules/localization/auto-restore.js');

const LOCALIZATION_MARKER = '// Antigravity 2.0 Chinese Localization Engine';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALIZE_SCRIPT = path.join(REPO_ROOT, 'modules', 'localization', 'localize.js');
const LOCALIZE_HEAD = fs.readFileSync(LOCALIZE_SCRIPT, 'utf8').slice(0, 4096);
const BUNDLED_VERSION =
  /\bCURRENT_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(LOCALIZE_HEAD)?.[1]?.trim() ||
  /\bRELEASE_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(LOCALIZE_HEAD)?.[1]?.trim() ||
  JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'modules', 'localization', 'package.json'), 'utf8')
  ).version;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

// Minimal but structurally valid ASAR archive:
//   [8-byte size pickle][header pickle][package.json bytes][extra marker]
// readAsarPackageVersion() reads the package entry at 8 + headerSize + offset.
function buildTestAsar(version, extraMarker = '') {
  const pkgBytes = Buffer.from(JSON.stringify({ name: 'antigravity', version }), 'utf8');
  const treeJson = Buffer.from(
    JSON.stringify({ files: { 'package.json': { size: pkgBytes.length, offset: '0' } } }),
    'utf8'
  );
  const headerSize = 8 + Math.ceil(treeJson.length / 4) * 4;

  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerSize, 4);

  const header = Buffer.alloc(headerSize);
  header.writeUInt32LE(headerSize - 4, 0);
  header.writeInt32LE(treeJson.length, 4);
  treeJson.copy(header, 8);

  return Buffer.concat([prefix, header, pkgBytes, Buffer.from(extraMarker, 'utf8')]);
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function makeWorkspace(t, prefix = 'agy-aio-localization-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const home = path.join(root, 'home');
  const appDir = path.join(root, 'Antigravity');
  const resourcesDir = path.join(appDir, 'resources');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });

  return {
    root,
    home,
    appDir,
    resourcesDir,
    asarPath: path.join(resourcesDir, 'app.asar'),
    backupAsarPath: path.join(resourcesDir, 'app.asar.bak'),
    platformInfo: {
      os: 'linux',
      arch: 'x64',
      isRoot: false,
      realUserHome: home,
      dataDir: path.join(home, '.agy-aio')
    }
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise(resolve => {
    if (!server.listening) {
      resolve();
      return;
    }
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

// Serves SHA256SUMS.txt and app.asar.ready over loopback so the online path
// exercises real downloads plus real SHA256 verification.
async function servePatch(t, patch) {
  const bodies = new Map([
    ['/SHA256SUMS.txt', Buffer.from(`${sha256Hex(patch)}  app.asar.ready\n`, 'utf8')],
    ['/app.asar.ready', patch]
  ]);

  const server = http.createServer((req, res) => {
    const body = bodies.get(req.url);
    if (!body) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': body.length
    });
    res.end(body);
  });

  const port = await listen(server);
  t.after(() => closeServer(server));

  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    releaseFetcher: async () => ({
      tag: 'v2.34.0',
      assets: [
        { name: 'app.asar.ready', url: `${base}/app.asar.ready`, size: patch.length },
        { name: 'SHA256SUMS.txt', url: `${base}/SHA256SUMS.txt`, size: 0 }
      ]
    })
  };
}

/* ------------------------------------------------------------------ *
 * ensureOfficialBackup
 * ------------------------------------------------------------------ */

test('ensureOfficialBackup creates app.asar.bak for a clean client', t => {
  const ws = makeWorkspace(t);
  fs.writeFileSync(ws.asarPath, buildTestAsar('2.34.0'));

  const result = ensureOfficialBackup({
    asarPath: ws.asarPath,
    backupAsarPath: ws.backupAsarPath,
    clientVersion: '2.34.0',
    platformInfo: ws.platformInfo
  });

  assert.equal(result.created, true);
  assert.equal(fs.existsSync(ws.backupAsarPath), true);
  assert.equal(readAsarPackageVersion(ws.backupAsarPath), '2.34.0');
  assert.equal(isLocalizedAsar(ws.backupAsarPath), false);
});

test('ensureOfficialBackup refuses to back up an already localized client', t => {
  const ws = makeWorkspace(t);
  fs.writeFileSync(ws.asarPath, buildTestAsar('2.34.0', LOCALIZATION_MARKER));

  const result = ensureOfficialBackup({
    asarPath: ws.asarPath,
    backupAsarPath: ws.backupAsarPath,
    clientVersion: '2.34.0',
    platformInfo: ws.platformInfo
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'source-already-localized');
  assert.equal(fs.existsSync(ws.backupAsarPath), false, 'no polluted backup may be created');
});

test('ensureOfficialBackup refreshes a localized app.asar.bak from a clean client', t => {
  const ws = makeWorkspace(t);
  fs.writeFileSync(ws.asarPath, buildTestAsar('2.34.0'));
  fs.writeFileSync(ws.backupAsarPath, buildTestAsar('2.34.0', LOCALIZATION_MARKER));

  const result = ensureOfficialBackup({
    asarPath: ws.asarPath,
    backupAsarPath: ws.backupAsarPath,
    clientVersion: '2.34.0',
    platformInfo: ws.platformInfo
  });

  assert.equal(result.refreshed, true);
  assert.equal(result.reason, 'backup-was-localized');
  assert.equal(isLocalizedAsar(ws.backupAsarPath), false);
  assert.equal(readAsarPackageVersion(ws.backupAsarPath), '2.34.0');
});

test('ensureOfficialBackup refreshes a backup left over from an older client', t => {
  const ws = makeWorkspace(t);
  fs.writeFileSync(ws.asarPath, buildTestAsar('2.34.0'));
  fs.writeFileSync(ws.backupAsarPath, buildTestAsar('2.33.0'));

  const result = ensureOfficialBackup({
    asarPath: ws.asarPath,
    backupAsarPath: ws.backupAsarPath,
    clientVersion: '2.34.0',
    platformInfo: ws.platformInfo
  });

  assert.equal(result.refreshed, true);
  assert.equal(result.reason, 'client-updated');
  assert.equal(result.oldVersion, '2.33.0');
  assert.equal(result.newVersion, '2.34.0');
  assert.equal(readAsarPackageVersion(ws.backupAsarPath), '2.34.0');
});

/* ------------------------------------------------------------------ *
 * SHA256SUMS parsing / verification
 * ------------------------------------------------------------------ */

test('parseSha256Sums and verifySha256Sums accept a valid hash and reject tampering', async t => {
  const ws = makeWorkspace(t, 'agy-aio-sha256-');
  const artifactPath = path.join(ws.root, 'app.asar.ready');
  const content = Buffer.from('localized payload for hashing', 'utf8');
  fs.writeFileSync(artifactPath, content);

  const digest = sha256Hex(content);
  const sumsText = [
    '# generated by test fixture',
    `${digest}  app.asar.ready`,
    `${'a'.repeat(64)}  other.bin`,
    ''
  ].join('\n');

  const parsed = parseSha256Sums(sumsText);
  assert.equal(parsed.get('app.asar.ready'), digest);
  assert.equal(parsed.get('other.bin'), 'a'.repeat(64));

  const valid = await verifySha256Sums(artifactPath, 'app.asar.ready', sumsText);
  assert.equal(valid.ok, true);
  assert.equal(valid.expected, digest);
  assert.equal(valid.actual, digest);

  const wrongSum = await verifySha256Sums(
    artifactPath,
    'app.asar.ready',
    `${'b'.repeat(64)}  app.asar.ready\n`
  );
  assert.equal(wrongSum.ok, false);
  assert.equal(wrongSum.expected, 'b'.repeat(64));

  fs.writeFileSync(artifactPath, Buffer.from('tampered payload', 'utf8'));
  const tampered = await verifySha256Sums(artifactPath, 'app.asar.ready', sumsText);
  assert.equal(tampered.ok, false);
  assert.equal(tampered.expected, digest);
  assert.notEqual(tampered.actual, digest);
});

/* ------------------------------------------------------------------ *
 * evaluateLocalizationCompatibility
 * ------------------------------------------------------------------ */

test('evaluateLocalizationCompatibility reports a clean match', () => {
  const compat = evaluateLocalizationCompatibility({
    clientVersion: '2.34.0',
    patchVersion: '2.34.0',
    bundledVersion: '2.34.0'
  });

  assert.equal(compat.status, 'match');
  assert.equal(compat.compatible, true);
  assert.equal(compat.clientVersion, '2.34.0');
  assert.equal(compat.patchVersion, '2.34.0');
  assert.match(compat.message, /精确匹配/);
});

test('evaluateLocalizationCompatibility prefers patchVersion over bundledVersion', () => {
  const compat = evaluateLocalizationCompatibility({
    clientVersion: '2.34.0',
    patchVersion: '2.34.0',
    bundledVersion: '2.33.0'
  });

  assert.equal(compat.status, 'match');
  assert.equal(compat.compatible, true);
  assert.equal(compat.patchVersion, '2.34.0');
});

test('evaluateLocalizationCompatibility flags a mismatch as incompatible', () => {
  const compat = evaluateLocalizationCompatibility({
    clientVersion: '2.34.0',
    patchVersion: '2.33.0'
  });

  assert.equal(compat.status, 'mismatch');
  assert.equal(compat.compatible, false);
  assert.equal(compat.clientVersion, '2.34.0');
  assert.equal(compat.patchVersion, '2.33.0');
  assert.match(compat.message, /2\.34\.0/);
  assert.match(compat.message, /2\.33\.0/);
  assert.match(compat.message, /白屏/);
});

test('evaluateLocalizationCompatibility falls back to bundledVersion for the patch version', () => {
  const compat = evaluateLocalizationCompatibility({
    clientVersion: '2.34.0',
    bundledVersion: '2.33.0'
  });

  assert.equal(compat.status, 'mismatch');
  assert.equal(compat.compatible, false);
  assert.equal(compat.patchVersion, '2.33.0');
});

test('evaluateLocalizationCompatibility treats missing version data as unknown but compatible', () => {
  const missingClient = evaluateLocalizationCompatibility({ patchVersion: '2.34.0' });
  assert.equal(missingClient.status, 'unknown');
  assert.equal(missingClient.compatible, true);
  assert.equal(missingClient.clientVersion, null);
  assert.equal(missingClient.patchVersion, '2.34.0');
  assert.match(missingClient.message, /无法读取完整版本信息/);

  const missingPatch = evaluateLocalizationCompatibility({ clientVersion: '2.34.0' });
  assert.equal(missingPatch.status, 'unknown');
  assert.equal(missingPatch.compatible, true);
  assert.equal(missingPatch.patchVersion, null);

  const empty = evaluateLocalizationCompatibility();
  assert.equal(empty.status, 'unknown');
  assert.equal(empty.compatible, true);
});

/* ------------------------------------------------------------------ *
 * getLocalizationStatus (version compatibility)
 * ------------------------------------------------------------------ */

test('getLocalizationStatus reports a version mismatch against bundledVersion', t => {
  const ws = makeWorkspace(t);
  fs.writeFileSync(ws.asarPath, buildTestAsar('2.99.0'));

  const status = getLocalizationStatus({ appDir: ws.appDir, platformInfo: ws.platformInfo });

  assert.equal(status.found, true);
  assert.equal(status.clientVersion, '2.99.0');
  assert.equal(status.bundledVersion, BUNDLED_VERSION);
  assert.equal(status.versionMatch, 'mismatch');
  assert.match(status.compatibilityMessage, /2\.99\.0/);
  assert.match(status.compatibilityMessage, new RegExp(escapeRegExp(BUNDLED_VERSION)));
  assert.match(status.compatibilityMessage, /白屏/);
});

test('getLocalizationStatus reports a clean match when the client equals bundledVersion', t => {
  const ws = makeWorkspace(t);
  fs.writeFileSync(ws.asarPath, buildTestAsar(BUNDLED_VERSION));

  const status = getLocalizationStatus({ appDir: ws.appDir, platformInfo: ws.platformInfo });

  assert.equal(status.found, true);
  assert.equal(status.clientVersion, BUNDLED_VERSION);
  assert.equal(status.bundledVersion, BUNDLED_VERSION);
  assert.equal(status.versionMatch, 'match');
  assert.match(status.compatibilityMessage, /精确匹配/);
});

test('getLocalizationStatus reports match when client is already localized even if newer than bundledVersion', t => {
  const ws = makeWorkspace(t);
  fs.writeFileSync(ws.asarPath, buildTestAsar('2.99.0', LOCALIZATION_MARKER));

  const status = getLocalizationStatus({ appDir: ws.appDir, platformInfo: ws.platformInfo });

  assert.equal(status.found, true);
  assert.equal(status.localized, true);
  assert.equal(status.clientVersion, '2.99.0');
  assert.equal(status.bundledVersion, BUNDLED_VERSION);
  assert.equal(status.bundledVersionMatch, 'mismatch');
  assert.equal(status.versionMatch, 'match');
  assert.match(status.compatibilityMessage, /已完成汉化/);
  assert.doesNotMatch(status.compatibilityMessage, /白屏/);
});

/* ------------------------------------------------------------------ *
 * installLocalization (online)
 * ------------------------------------------------------------------ */

test('installLocalization online installs a matching localized patch', async t => {
  const ws = makeWorkspace(t);
  const cleanClient = buildTestAsar('2.34.0');
  const localizedPatch = buildTestAsar('2.34.0', LOCALIZATION_MARKER);
  fs.writeFileSync(ws.asarPath, cleanClient);

  const { releaseFetcher } = await servePatch(t, localizedPatch);

  const result = await installLocalization({
    appDir: ws.appDir,
    mode: 'online',
    platformInfo: ws.platformInfo,
    releaseFetcher
  });

  assert.equal(result.installed, true);
  assert.equal(result.method, 'online');
  assert.equal(result.clientVersion, '2.34.0');
  assert.equal(result.patchVersion, '2.34.0');

  assert.equal(readAsarPackageVersion(ws.asarPath), '2.34.0');
  assert.equal(isLocalizedAsar(ws.asarPath), true);
  assert.ok(
    fs.readFileSync(ws.asarPath).includes(Buffer.from(LOCALIZATION_MARKER)),
    'app.asar must contain the localization marker after install'
  );

  assert.equal(fs.existsSync(ws.backupAsarPath), true);
  assert.equal(readAsarPackageVersion(ws.backupAsarPath), '2.34.0');
  assert.equal(isLocalizedAsar(ws.backupAsarPath), false);
  assert.deepEqual(fs.readFileSync(ws.backupAsarPath), cleanClient);
});

test('installLocalization online rejects a patch built for another client version', async t => {
  const ws = makeWorkspace(t);
  const cleanClient = buildTestAsar('2.34.0');
  const mismatchedPatch = buildTestAsar('2.33.0', LOCALIZATION_MARKER);
  fs.writeFileSync(ws.asarPath, cleanClient);

  const { releaseFetcher } = await servePatch(t, mismatchedPatch);

  await assert.rejects(
    installLocalization({
      appDir: ws.appDir,
      mode: 'online',
      platformInfo: ws.platformInfo,
      releaseFetcher
    }),
    /does not match client version/
  );

  assert.deepEqual(fs.readFileSync(ws.asarPath), cleanClient, 'client asar must not be overwritten');
  assert.equal(fs.existsSync(ws.backupAsarPath), false);
});

test('installLocalization online rejects an unreadable patch for a known client version', async t => {
  const ws = makeWorkspace(t);
  const cleanClient = buildTestAsar('2.34.0');
  // Valid SHA256, but the bytes are not an ASAR archive, so the patch version
  // cannot be read (patchVersion === null) and installation must be refused.
  const unreadablePatch = Buffer.from('not an ASAR archive: localization payload', 'utf8');
  fs.writeFileSync(ws.asarPath, cleanClient);

  const { releaseFetcher } = await servePatch(t, unreadablePatch);

  await assert.rejects(
    installLocalization({
      appDir: ws.appDir,
      mode: 'online',
      platformInfo: ws.platformInfo,
      releaseFetcher
    }),
    error => {
      assert.match(error.message, /无法读取在线汉化补丁版本号/);
      assert.match(error.message, /2\.34\.0/);
      return true;
    }
  );

  assert.deepEqual(fs.readFileSync(ws.asarPath), cleanClient, 'client asar must not be overwritten');
  assert.equal(fs.existsSync(ws.backupAsarPath), false);
});

/* ------------------------------------------------------------------ *
 * installLocalization (auto white-screen protection)
 * ------------------------------------------------------------------ */

test('installLocalization auto refuses local fallback when the online patch mismatches a newer client', async t => {
  const ws = makeWorkspace(t);
  const cleanClient = buildTestAsar('2.99.0');
  const mismatchedPatch = buildTestAsar('2.34.0', LOCALIZATION_MARKER);
  fs.writeFileSync(ws.asarPath, cleanClient);

  const { releaseFetcher } = await servePatch(t, mismatchedPatch);

  await assert.rejects(
    installLocalization({
      appDir: ws.appDir,
      mode: 'auto',
      platformInfo: ws.platformInfo,
      releaseFetcher
    }),
    error => {
      assert.match(error.message, /已拒绝自动回退本地重建以防白屏/);
      assert.match(error.message, /2\.99\.0/);
      assert.match(error.message, new RegExp(escapeRegExp(BUNDLED_VERSION)));
      assert.match(error.message, /--allow-version-mismatch/);
      return true;
    }
  );

  assert.deepEqual(fs.readFileSync(ws.asarPath), cleanClient, 'client asar must not be overwritten');
  assert.equal(isLocalizedAsar(ws.asarPath), false, 'no local rebuild may be applied');
  assert.equal(fs.existsSync(ws.backupAsarPath), false);
});

test('installLocalization auto refuses local fallback when the release lookup fails for a newer client', async t => {
  const ws = makeWorkspace(t);
  const cleanClient = buildTestAsar('2.99.0');
  fs.writeFileSync(ws.asarPath, cleanClient);

  await assert.rejects(
    installLocalization({
      appDir: ws.appDir,
      mode: 'auto',
      platformInfo: ws.platformInfo,
      releaseFetcher: async () => {
        throw new Error('network unavailable');
      }
    }),
    error => {
      assert.match(error.message, /已拒绝回退本地重建以防白屏/);
      assert.match(error.message, /2\.99\.0/);
      assert.match(error.message, new RegExp(escapeRegExp(BUNDLED_VERSION)));
      assert.match(error.message, /--allow-version-mismatch/);
      return true;
    }
  );

  assert.deepEqual(fs.readFileSync(ws.asarPath), cleanClient, 'client asar must not be overwritten');
  assert.equal(isLocalizedAsar(ws.asarPath), false, 'no local rebuild may be applied');
});

/* ------------------------------------------------------------------ *
 * uninstallLocalization
 * ------------------------------------------------------------------ */

test('uninstallLocalization restores a matching official backup', t => {
  const ws = makeWorkspace(t);
  const cleanClient = buildTestAsar('2.34.0');
  fs.writeFileSync(ws.asarPath, buildTestAsar('2.34.0', LOCALIZATION_MARKER));
  fs.writeFileSync(ws.backupAsarPath, cleanClient);

  const result = uninstallLocalization({ appDir: ws.appDir, platformInfo: ws.platformInfo });

  assert.equal(result.restored, true);
  assert.equal(result.asarPath, ws.asarPath);
  assert.deepEqual(fs.readFileSync(ws.asarPath), cleanClient);
  assert.equal(readAsarPackageVersion(ws.asarPath), '2.34.0');
  assert.equal(isLocalizedAsar(ws.asarPath), false);
});

test('uninstallLocalization refuses a stale cross-version backup', t => {
  const ws = makeWorkspace(t);
  const localizedClient = buildTestAsar('2.34.0', LOCALIZATION_MARKER);
  fs.writeFileSync(ws.asarPath, localizedClient);
  fs.writeFileSync(ws.backupAsarPath, buildTestAsar('2.33.0'));

  assert.throws(
    () => uninstallLocalization({ appDir: ws.appDir, platformInfo: ws.platformInfo }),
    /different client version/
  );

  assert.deepEqual(fs.readFileSync(ws.asarPath), localizedClient, 'stale restore must not white-screen the app');
});
