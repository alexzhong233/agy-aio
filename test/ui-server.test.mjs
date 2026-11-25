// Isolated tests for lib/ui-server/server.mjs.
//
// Every writable path points into a fresh mkdtemp sandbox. Because
// getPlatformInfo() derives its dataDir from os.homedir(), the process HOME /
// USERPROFILE are redirected for the duration of the HTTP test and restored in
// t.after(). The real /Applications/Antigravity.app is never written:
//   * POST /api/proxy/config is exercised with sync:false (save only), and
//   * collectSyncDirs() is covered directly with pure fake installation
//     objects for darwin / linux / win32 (no filesystem access at all).

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { startUiServer, collectSyncDirs } from '../lib/ui-server/server.mjs';

const ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'AGY_CAPSULE_PLUGINS_DIR',
  'AGY_AIO_APPLICATIONS_DIR',
  'AGY_AIO_UPDATER_CACHE_DIR'
];

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-aio-ui-'));
  const home = path.join(root, 'home');
  const plugins = path.join(root, 'plugins');
  const localAppData = path.join(root, 'localappdata');
  const appsDir = path.join(root, 'Applications');
  const updaterCacheDir = path.join(root, 'updater-cache');
  for (const dir of [home, plugins, localAppData, appsDir, updaterCacheDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: localAppData,
    AGY_CAPSULE_PLUGINS_DIR: plugins,
    AGY_AIO_APPLICATIONS_DIR: appsDir,
    AGY_AIO_UPDATER_CACHE_DIR: updaterCacheDir
  };
  // getPlatformInfo() only treats a process as sudo when the *passed* env says so.
  delete env.SUDO_USER;
  delete env.SUDO_UID;
  delete env.SUDO_GID;

  const saved = new Map();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    process.env[key] = env[key];
  }

  // A dead proxy port keeps the status endpoint's TCP probe instantaneous and
  // independent of whatever proxy happens to run on the test machine.
  const configPath = path.join(home, '.agy-aio', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ proxy: { host: '127.0.0.1', port: 1, type: 'socks5' } }, null, 2)}\n`,
    'utf8'
  );

  return {
    root,
    home,
    plugins,
    appsDir,
    updaterCacheDir,
    env,
    configPath,
    restore() {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function makeFakeApp(root, platform) {
  if (platform === 'darwin') {
    const appDir = path.join(root, 'Antigravity.app');
    fs.mkdirSync(appDir, { recursive: true });
    return appDir;
  }

  if (platform === 'win32') {
    const appDir = path.join(root, 'Antigravity');
    fs.mkdirSync(path.join(appDir, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'Antigravity.exe'), '', 'utf8');
    return appDir;
  }

  const appDir = path.join(root, 'antigravity');
  fs.mkdirSync(path.join(appDir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'resources', 'app.asar'), '', 'utf8');
  return appDir;
}

function request(port, { method = 'GET', path: requestPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: requestPath,
        agent: false,
        headers: {
          ...(payload
            ? {
                'content-type': 'application/json',
                'content-length': String(payload.length)
              }
            : {}),
          ...headers
        }
      },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Minimal RFC 1928 SOCKS5 server: method negotiation + CONNECT success reply.
// It never dials the real target, so /api/proxy/test is fully offline.
function startMockSocks5(t) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const server = net.createServer(socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});

      let stage = 'greeting';
      socket.on('data', () => {
        if (stage === 'greeting') {
          socket.write(Buffer.from([0x05, 0x00]));
          stage = 'connect';
          return;
        }
        // VER, REP=0, RSV, ATYP=IPv4, BND.ADDR=0.0.0.0, BND.PORT=0
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
        stage = 'done';
      });
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      t.after(
        () =>
          new Promise(done => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          })
      );
      resolve(port);
    });
  });
}

/* ------------------------------------------------------------------ *
 * collectSyncDirs: pure unit tests, zero disk access
 * ------------------------------------------------------------------ */

test('collectSyncDirs finds the fake desktop bin dirs on darwin and linux', () => {
  for (const platform of ['darwin', 'linux']) {
    const appDir = path.join(os.tmpdir(), 'agy-aio-fake-Antigravity.app');
    const binDir =
      platform === 'darwin'
        ? path.join(appDir, 'Contents', 'Resources', 'bin')
        : path.join(appDir, 'resources', 'bin');
    const ideBinDir =
      platform === 'darwin'
        ? path.join(os.tmpdir(), 'agy-aio-fake-Antigravity-IDE.app', 'Contents', 'Resources', 'app', 'extensions', 'antigravity', 'bin')
        : path.join(os.tmpdir(), 'agy-aio-fake-Antigravity-IDE', 'resources', 'bin');

    const dirs = collectSyncDirs(
      {
        desktop: [{ languageServers: [path.join(binDir, 'language_server')] }],
        ide: [
          {
            languageServers: [
              path.join(ideBinDir, 'language_server_macos_arm'),
              path.join(ideBinDir, 'language_server_macos_x64')
            ]
          }
        ],
        cli: [{ cliBinPath: path.join(os.tmpdir(), 'agy-aio-fake-bin', 'agy') }]
      },
      platform
    );

    assert.ok(dirs.includes(path.resolve(binDir)), `${platform}: desktop bin dir`);
    assert.ok(dirs.includes(path.resolve(ideBinDir)), `${platform}: ide bin dir`);
    assert.ok(
      dirs.includes(path.resolve(path.join(os.tmpdir(), 'agy-aio-fake-bin'))),
      `${platform}: cli bin dir`
    );
    assert.equal(new Set(dirs).size, dirs.length, `${platform}: no duplicates`);
  }
});

test('collectSyncDirs handles win32 exe, resources and CLI paths', () => {
  const root = path.join(os.tmpdir(), 'agy-aio-fake-win');
  const desktop = { exePath: path.join(root, 'Antigravity', 'Antigravity.exe') };
  const ide = { resourcesDir: path.join(root, 'Antigravity IDE', 'resources') };
  const cli = { cliBinPath: path.join(root, 'agy', 'bin', 'agy.exe') };

  const dirs = collectSyncDirs({ desktop: [desktop], ide: [ide], cli: [cli] }, 'win32');

  assert.ok(dirs.includes(path.resolve(path.dirname(desktop.exePath))));
  assert.ok(dirs.includes(path.resolve(ide.resourcesDir)));
  assert.ok(dirs.includes(path.resolve(path.dirname(cli.cliBinPath))));
  assert.equal(new Set(dirs).size, dirs.length);
});

test('collectSyncDirs tolerates empty or malformed installation maps', () => {
  assert.deepEqual(collectSyncDirs(null, 'darwin'), []);
  assert.deepEqual(collectSyncDirs({}, 'linux'), []);
  assert.deepEqual(collectSyncDirs({ desktop: [], ide: [], cli: [] }, 'win32'), []);
});

/* ------------------------------------------------------------------ *
 * Live server against the sandbox
 * ------------------------------------------------------------------ */

test('UI server: CSRF/origin/host checks, isolated config save and dry-run install', async t => {
  const sandbox = makeSandbox();
  let server = null;
  t.after(async () => {
    if (server) await server.close();
    sandbox.restore();
  });

  // Safety net: bail out before starting the server if the HOME override did
  // not take effect, because the config path would then escape the sandbox.
  assert.equal(os.homedir(), sandbox.home, 'HOME must point into the sandbox');

  const appDir = makeFakeApp(sandbox.root, process.platform);
  server = await startUiServer({
    port: 0,
    appDir,
    pluginsDir: sandbox.plugins,
    env: sandbox.env
  });

  assert.ok(server.port > 0);
  assert.equal(server.host, '127.0.0.1');

  let csrfToken = null;

  await t.test('GET / serves the panel and embeds the CSRF token', async () => {
    const res = await request(server.port, { path: '/' });

    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /^text\/html/);

    const match = /<meta name="agy-aio-token" content="([0-9a-f]{64})">/.exec(res.text);
    assert.ok(match, 'meta agy-aio-token must be present');
    csrfToken = match[1];
    assert.equal(csrfToken, server.csrfToken);
  });

  await t.test('GET / renders system theme, cdpMode selector and collapsed advanced proxy settings', async () => {
    const res = await request(server.port, { path: '/' });

    assert.equal(res.status, 200);
    assert.ok(res.text.includes('@media (prefers-color-scheme: dark)'), 'system theme media query');
    assert.ok(res.text.includes('data-theme="light"'), 'light theme attribute');
    assert.ok(res.text.includes('data-theme="dark"'), 'dark theme attribute');
    assert.ok(res.text.includes('data-theme-choice="system"'), 'system theme choice');
    assert.ok(res.text.includes('data-theme-choice="light"'), 'light theme choice');
    assert.ok(res.text.includes('data-theme-choice="dark"'), 'dark theme choice');
    assert.ok(res.text.includes('id="cdpMode"'), 'cdpMode selector');
    assert.ok(res.text.includes('<details class="adv">'), 'advanced proxy panel is collapsed by default');
    assert.ok(res.text.includes('id="clientUpdateBanner"'), 'client update banner');
    assert.ok(res.text.includes('id="btnBannerUpgrade"'), 'banner upgrade button');
    assert.ok(res.text.includes('id="btnUpgradeClient"'), 'client upgrade button');
  });

  await t.test('GET /api/status returns the expected sections', async () => {
    const res = await request(server.port, { path: '/api/status' });

    assert.equal(res.status, 200);
    assert.ok(res.json);
    for (const key of ['platform', 'capsule', 'localization', 'proxy', 'clientUpdate', 'config']) {
      assert.ok(res.json[key] && typeof res.json[key] === 'object', `status.${key}`);
    }
    assert.equal(res.json.platform.os, process.platform);
    assert.equal(res.json.configPath, sandbox.configPath);
  });

  await t.test('GET /api/status rejects a forged Host header', async () => {
    const res = await request(server.port, {
      path: '/api/status',
      headers: { host: 'evil.example:1234' }
    });

    assert.equal(res.status, 403);
  });

  await t.test('POST /api/proxy/config requires the CSRF token', async () => {
    const body = { proxy: { host: '127.0.0.1', port: 7897, type: 'http' }, sync: false };

    const missing = await request(server.port, {
      method: 'POST',
      path: '/api/proxy/config',
      body
    });
    assert.equal(missing.status, 403);

    const wrong = await request(server.port, {
      method: 'POST',
      path: '/api/proxy/config',
      headers: { 'x-agy-aio-token': 'f'.repeat(64) },
      body
    });
    assert.equal(wrong.status, 403);
  });

  await t.test('POST /api/proxy/config rejects a cross-origin request', async () => {
    const res = await request(server.port, {
      method: 'POST',
      path: '/api/proxy/config',
      headers: { 'x-agy-aio-token': csrfToken, origin: 'http://evil.com' },
      body: { proxy: { host: '127.0.0.1', port: 7897, type: 'http' }, sync: false }
    });

    assert.equal(res.status, 403);
  });

  await t.test('POST /api/proxy/config saves into the sandbox config path', async () => {
    // sync:false is deliberate: detectInstallations() always probes the real
    // /Applications/Antigravity.app on macOS, and sync:true would write there.
    const res = await request(server.port, {
      method: 'POST',
      path: '/api/proxy/config',
      headers: { 'x-agy-aio-token': csrfToken },
      body: { proxy: { host: '127.0.0.1', port: 7897, type: 'http' }, sync: false }
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.path, sandbox.configPath);
    assert.deepEqual(res.json.syncedDirs, []);
    assert.equal(res.json.syncErrors, undefined);

    const saved = JSON.parse(fs.readFileSync(sandbox.configPath, 'utf8'));
    assert.equal(saved.proxy.host, '127.0.0.1');
    assert.equal(saved.proxy.port, 7897);
    assert.equal(saved.proxy.type, 'http');
  });

  await t.test('POST /api/proxy/config rejects an out-of-range port', async () => {
    const res = await request(server.port, {
      method: 'POST',
      path: '/api/proxy/config',
      headers: { 'x-agy-aio-token': csrfToken },
      body: { proxy: { host: '127.0.0.1', port: 99999, type: 'http' }, sync: false }
    });

    assert.equal(res.status, 400);
    assert.equal(res.json.ok, false);
  });

  await t.test('POST /api/proxy/test succeeds against a mock SOCKS5 server', async () => {
    const mockPort = await startMockSocks5(t);

    const res = await request(server.port, {
      method: 'POST',
      path: '/api/proxy/test',
      headers: { 'x-agy-aio-token': csrfToken },
      body: { host: '127.0.0.1', port: mockPort, type: 'socks5' }
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.ok(Array.isArray(res.json.results));
    assert.equal(res.json.results.length, 2);
    for (const result of res.json.results) {
      assert.equal(result.ok, true);
      assert.equal(result.proxyPort, mockPort);
    }
  });

  await t.test('POST /api/actions/install dry-run writes nothing to the plugin dir', async () => {
    const before = fs.existsSync(sandbox.plugins) ? fs.readdirSync(sandbox.plugins).sort() : [];

    const res = await request(server.port, {
      method: 'POST',
      path: '/api/actions/install',
      headers: { 'x-agy-aio-token': csrfToken },
      body: { only: ['capsule'], dryRun: true }
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.ok(Array.isArray(res.json.logs));
    assert.ok(res.json.logs.length > 0);
    assert.equal(fs.existsSync(path.join(sandbox.plugins, 'agy-capsule')), false);

    const after = fs.existsSync(sandbox.plugins) ? fs.readdirSync(sandbox.plugins).sort() : [];
    assert.deepEqual(after, before);
  });

  await t.test('POST /api/actions/install validates cdpMode and allows native dry-run', async () => {
    const native = await request(server.port, {
      method: 'POST',
      path: '/api/actions/install',
      headers: { 'x-agy-aio-token': csrfToken },
      body: { only: ['capsule'], cdpMode: 'native', dryRun: true }
    });

    assert.equal(native.status, 200);
    assert.equal(native.json.ok, true);
    assert.equal(fs.existsSync(path.join(sandbox.plugins, 'agy-capsule')), false);

    const bogus = await request(server.port, {
      method: 'POST',
      path: '/api/actions/install',
      headers: { 'x-agy-aio-token': csrfToken },
      body: { only: ['capsule'], cdpMode: 'bogus', dryRun: true }
    });

    assert.equal(bogus.status, 400);
    assert.equal(bogus.json.ok, false);
  });

  await t.test('POST /api/actions/uninstall supports undoCdp in dry-run mode', async () => {
    const res = await request(server.port, {
      method: 'POST',
      path: '/api/actions/uninstall',
      headers: { 'x-agy-aio-token': csrfToken },
      body: { only: ['capsule'], undoCdp: true, dryRun: true }
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  });

  await t.test('POST /api/actions/upgrade validates cdpMode and allows offline local-package dry-run', async () => {
    const bogus = await request(server.port, {
      method: 'POST',
      path: '/api/actions/upgrade',
      headers: { 'x-agy-aio-token': csrfToken },
      body: { cdpMode: 'bogus', dryRun: true }
    });

    assert.equal(bogus.status, 400);
    assert.equal(bogus.json.ok, false);

    // A closed loopback port makes fetchClientManifest fail immediately with
    // ECONNREFUSED, so upgradeClient falls back to the staged pending package.
    // No external network is contacted and dryRun prevents downloads/writes.
    const closedPort = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });

    const ymlPath =
      process.platform === 'darwin'
        ? path.join(appDir, 'Contents', 'Resources', 'app-update.yml')
        : path.join(appDir, 'resources', 'app-update.yml');
    fs.mkdirSync(path.dirname(ymlPath), { recursive: true });
    fs.writeFileSync(
      ymlPath,
      `url: http://127.0.0.1:${closedPort}/manifest/\nprovider: generic\n`,
      'utf8'
    );

    const pendingDir = path.join(sandbox.updaterCacheDir, 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    const zipBytes = Buffer.from('a tiny staged Antigravity package');
    const digest = crypto.createHash('sha512').update(zipBytes).digest('base64');
    fs.writeFileSync(path.join(pendingDir, 'Antigravity.zip'), zipBytes);
    fs.writeFileSync(
      path.join(pendingDir, 'update-info.json'),
      `${JSON.stringify({
        fileName: 'Antigravity.zip',
        sha512: digest,
        size: zipBytes.length
      })}\n`,
      'utf8'
    );

    const listFiles = dir => {
      const out = [];
      const walk = current => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const target = path.join(current, entry.name);
          if (entry.isDirectory()) walk(target);
          else out.push(path.relative(dir, target));
        }
      };
      walk(dir);
      return out.sort();
    };
    const before = listFiles(appDir);

    const res = await request(server.port, {
      method: 'POST',
      path: '/api/actions/upgrade',
      headers: { 'x-agy-aio-token': csrfToken },
      body: { cdpMode: 'native', noRestore: true, dryRun: true }
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.result.dryRun, true);
    assert.equal(res.json.result.upgrade.dryRun, true);
    assert.equal(res.json.result.upgrade.upgraded, false);
    assert.equal(res.json.result.upgrade.source, 'pending-offline');
    assert.deepEqual(listFiles(appDir), before);
  });
});
