// Isolated tests for lib/platform.mjs. Every test works inside a fresh
// mkdtemp directory and never reads or writes the real Antigravity install.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {
  detectInstallations,
  atomicWriteFile,
  atomicCopy,
  isPortOpen,
  detectLocalProxyPort
} from '../lib/platform.mjs';

function makeRoot(t, prefix = 'agy-aio-platform-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makePlatformInfo(root, overrides = {}) {
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  return {
    os: process.platform,
    arch: process.arch,
    isRoot: false,
    realUser: null,
    realUserHome: home,
    realUid: null,
    realGid: null,
    dataDir: path.join(home, '.agy-aio'),
    ...overrides
  };
}

function listLeftoverTemps(dir) {
  return fs.readdirSync(dir).filter(name => name.includes('.agy-aio.tmp.'));
}

test('detectInstallations finds a darwin desktop bundle with language_server', t => {
  const root = makeRoot(t);
  const app = path.join(root, 'Applications', 'Antigravity.app');
  const resources = path.join(app, 'Contents', 'Resources');
  fs.mkdirSync(path.join(resources, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'app.asar'), 'fake asar');
  const languageServer = path.join(resources, 'bin', 'language_server');
  fs.writeFileSync(languageServer, 'fake ls');

  const platformInfo = makePlatformInfo(root, { os: 'darwin' });
  const result = detectInstallations({ appDir: app, platformInfo, env: {} });

  const entry = result.desktop.find(item => item.rootDir === path.resolve(app));
  assert.ok(entry, 'expected the fake desktop bundle to be detected');
  assert.equal(entry.kind, 'desktop');
  assert.equal(entry.asarPath, path.join(resources, 'app.asar'));
  assert.deepEqual(entry.languageServers, [path.resolve(languageServer)]);
  assert.ok(result.primaryDesktop);
});

test('detectInstallations falls back to language_server.orig on darwin', t => {
  const root = makeRoot(t);
  const app = path.join(root, 'Applications', 'Antigravity.app');
  const resources = path.join(app, 'Contents', 'Resources');
  fs.mkdirSync(path.join(resources, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'app.asar'), 'fake asar');
  const orig = path.join(resources, 'bin', 'language_server.orig');
  fs.writeFileSync(orig, 'fake orig ls');

  const platformInfo = makePlatformInfo(root, { os: 'darwin' });
  const result = detectInstallations({ appDir: app, platformInfo, env: {} });

  const entry = result.desktop.find(item => item.rootDir === path.resolve(app));
  assert.ok(entry, 'expected the fake desktop bundle to be detected');
  assert.deepEqual(entry.languageServers, [path.resolve(orig)]);
  assert.ok(
    !entry.languageServers.some(p => p.endsWith('language_server')),
    'the missing primary language_server must not appear'
  );
});

test('detectInstallations finds a win32 desktop app passed via appDir', t => {
  const root = makeRoot(t);
  const appDir = path.join(root, 'Antigravity');
  fs.mkdirSync(path.join(appDir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'Antigravity.exe'), 'fake exe');
  fs.writeFileSync(path.join(appDir, 'resources', 'app.asar'), 'fake asar');

  const platformInfo = makePlatformInfo(root, { os: 'win32', arch: 'x64' });
  const env = { LOCALAPPDATA: path.join(root, 'AppData', 'Local') };
  const result = detectInstallations({ appDir, platformInfo, env });

  const entry = result.desktop.find(item => item.rootDir === path.resolve(appDir));
  assert.ok(entry, 'expected the fake win32 desktop app to be detected');
  assert.equal(entry.exePath, path.join(appDir, 'Antigravity.exe'));
  assert.equal(entry.asarPath, path.join(appDir, 'resources', 'app.asar'));
});

test('detectInstallations finds a linux desktop app passed via appDir', t => {
  const root = makeRoot(t);
  const appDir = path.join(root, 'Antigravity');
  fs.mkdirSync(path.join(appDir, 'resources', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'antigravity'), 'fake exe');
  fs.writeFileSync(path.join(appDir, 'resources', 'app.asar'), 'fake asar');
  const languageServer = path.join(appDir, 'resources', 'bin', 'language_server');
  fs.writeFileSync(languageServer, 'fake ls');

  const platformInfo = makePlatformInfo(root, { os: 'linux', arch: 'x64' });
  const result = detectInstallations({ appDir, platformInfo, env: {} });

  const entry = result.desktop.find(item => item.rootDir === path.resolve(appDir));
  assert.ok(entry, 'expected the fake linux desktop app to be detected');
  assert.equal(entry.exePath, path.join(appDir, 'antigravity'));
  assert.equal(entry.asarPath, path.join(appDir, 'resources', 'app.asar'));
  assert.deepEqual(entry.languageServers, [path.resolve(languageServer)]);
});

test('atomicWriteFile writes accurate content and leaves no temp files', t => {
  const root = makeRoot(t);
  const dest = path.join(root, 'nested', 'dir', 'payload.txt');
  const content = 'hello atomic world\n';

  atomicWriteFile(dest, content);

  assert.equal(fs.readFileSync(dest, 'utf8'), content);
  assert.deepEqual(listLeftoverTemps(path.dirname(dest)), []);
});

test('atomicCopy copies accurate content and leaves no temp files', t => {
  const root = makeRoot(t);
  const src = path.join(root, 'source.bin');
  const content = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff, 0x0a]);
  fs.writeFileSync(src, content);

  const dest = path.join(root, 'output', 'copy.bin');
  atomicCopy(src, dest);

  assert.deepEqual(fs.readFileSync(dest), content);
  assert.deepEqual(listLeftoverTemps(path.dirname(dest)), []);
});

test('isPortOpen reflects an ephemeral listening server', async t => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => {
    if (server.listening) server.close();
  });

  const port = server.address().port;
  assert.equal(await isPortOpen('127.0.0.1', port), true);

  await new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
  assert.equal(await isPortOpen('127.0.0.1', port), false);
});

test('detectLocalProxyPort resolves HTTP_PROXY against a live port', async t => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => {
    if (server.listening) server.close();
  });

  const port = server.address().port;
  const detected = await detectLocalProxyPort({
    env: { HTTP_PROXY: `http://127.0.0.1:${port}` }
  });

  assert.deepEqual(detected, {
    host: '127.0.0.1',
    port,
    type: 'http',
    source: 'HTTP_PROXY'
  });
});

test('detectLocalProxyPort ignores a dead HTTP_PROXY endpoint', async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });

  const detected = await detectLocalProxyPort({
    host: '127.0.0.1',
    ports: [],
    env: { HTTP_PROXY: `http://127.0.0.1:${port}` }
  });

  assert.equal(detected, null);
});
