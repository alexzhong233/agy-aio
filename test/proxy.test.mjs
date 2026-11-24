// Isolated tests for lib/modules/proxy.mjs. A linux platformInfo plus temp
// dataDir/bin fixtures keep the POSIX patching path away from the real
// /Applications/Antigravity.app, real ~/.agy-aio and macOS code signing.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  getProxyStatus,
  installProxy,
  testProxyConnectivity,
  uninstallProxy,
  validateWindowsDeployPlan
} from '../lib/modules/proxy.mjs';
import { getDefaultConfig } from '../lib/config.mjs';

const ORIGINAL_V1 = 'ORIGINAL_BINARY_V1';
const ORIGINAL_V2 = 'ORIGINAL_BINARY_V2';
const LAUNCHER_CONTENT = '#!/bin/sh\n# anti-proxy-launcher\n';
const PROXY_LIB_CONTENT = '__FAKE_PROXY_LIB__';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function makeWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-aio-proxy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const home = path.join(root, 'home');
  const dataDir = path.join(home, '.agy-aio');
  const appDir = path.join(root, 'Antigravity');
  const resourcesDir = path.join(appDir, 'resources');
  const resourcesBin = path.join(resourcesDir, 'bin');
  const cacheBin = path.join(dataDir, 'bin');

  fs.mkdirSync(resourcesBin, { recursive: true });
  fs.mkdirSync(cacheBin, { recursive: true });

  // Cached POSIX artifacts; the repo checkout has no prebuilt .so/launcher,
  // so installProxy() resolves these temp copies.
  fs.writeFileSync(path.join(cacheBin, 'libantigravity_proxy.so'), PROXY_LIB_CONTENT);
  fs.writeFileSync(path.join(cacheBin, 'anti-proxy-launcher'), LAUNCHER_CONTENT);

  const languageServer = path.join(resourcesBin, 'language_server');
  fs.writeFileSync(languageServer, ORIGINAL_V1);

  return {
    root,
    home,
    dataDir,
    appDir,
    resourcesDir,
    resourcesBin,
    languageServer,
    platformInfo: {
      os: 'linux',
      arch: 'x64',
      isRoot: false,
      realUserHome: home,
      dataDir
    }
  };
}

// On a macOS host signBinaryAdhoc() shells out to `codesign` even when
// platformInfo says linux. Prepend a no-op codesign shim so dummy text
// fixtures are never handed to the real signing toolchain.
function useFakeCodesign(t, root) {
  const shimDir = path.join(root, 'codesign-shim');
  fs.mkdirSync(shimDir, { recursive: true });
  const shimPath = path.join(shimDir, 'codesign');
  fs.writeFileSync(shimPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(shimPath, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${shimDir}${path.delimiter}${previousPath ?? ''}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
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

/* ------------------------------------------------------------------ *
 * POSIX patch / unpatch
 * ------------------------------------------------------------------ */

test('POSIX install, official-update refresh, and uninstall cycle', async t => {
  const ws = makeWorkspace(t);
  useFakeCodesign(t, ws.root);

  const config = getDefaultConfig({ host: '127.0.0.1', port: 65533, type: 'socks5' });
  const origPath = `${ws.languageServer}.orig`;

  /* --- install --------------------------------------------------- */
  const installed = await installProxy({
    appDir: ws.appDir,
    config,
    platformInfo: ws.platformInfo
  });

  assert.equal(installed.installed, true);
  assert.deepEqual(installed.patchedTargets, [ws.languageServer]);
  assert.equal(fs.readFileSync(origPath, 'utf8'), ORIGINAL_V1, '.orig keeps the original binary');
  assert.match(fs.readFileSync(ws.languageServer, 'utf8'), /anti-proxy-launcher/);
  assert.equal(fs.existsSync(path.join(ws.resourcesBin, 'libantigravity_proxy.so')), true);
  assert.equal(fs.existsSync(path.join(ws.resourcesBin, 'config.json')), true);

  let status = await getProxyStatus({
    appDir: ws.appDir,
    config,
    platformInfo: ws.platformInfo
  });
  assert.equal(status.os, 'linux');
  assert.equal(status.targets.length, 1);
  assert.equal(status.targets[0].patched, true);

  /* --- official update overwrites the live binary ---------------- */
  fs.writeFileSync(ws.languageServer, ORIGINAL_V2);

  status = await getProxyStatus({ appDir: ws.appDir, config, platformInfo: ws.platformInfo });
  assert.equal(status.targets[0].patched, false, 'a stale .orig must not look patched');
  assert.equal(fs.readFileSync(origPath, 'utf8'), ORIGINAL_V1);

  /* --- re-install refreshes the stale .orig ---------------------- */
  await installProxy({ appDir: ws.appDir, config, platformInfo: ws.platformInfo });

  assert.equal(fs.readFileSync(origPath, 'utf8'), ORIGINAL_V2);
  assert.match(fs.readFileSync(ws.languageServer, 'utf8'), /anti-proxy-launcher/);

  status = await getProxyStatus({ appDir: ws.appDir, config, platformInfo: ws.platformInfo });
  assert.equal(status.targets[0].patched, true);

  /* --- uninstall ------------------------------------------------- */
  const uninstalled = await uninstallProxy({
    appDir: ws.appDir,
    platformInfo: ws.platformInfo
  });

  assert.equal(uninstalled.restored, true);
  assert.equal(fs.readFileSync(ws.languageServer, 'utf8'), ORIGINAL_V2);
  assert.equal(fs.existsSync(origPath), false);
  assert.equal(fs.existsSync(path.join(ws.resourcesBin, 'libantigravity_proxy.so')), false);

  status = await getProxyStatus({ appDir: ws.appDir, config, platformInfo: ws.platformInfo });
  assert.equal(status.targets[0].patched, false);
});

/* ------------------------------------------------------------------ *
 * Windows DLL separation guard
 * ------------------------------------------------------------------ */

function makeWindowsPlan() {
  return [
    { kind: 'desktop', targetDir: '/tmp/Antigravity', files: ['version.dll'] },
    { kind: 'ide', targetDir: '/tmp/Antigravity IDE', files: ['version.dll'] },
    {
      kind: 'cli',
      targetDir: '/tmp/agy/bin',
      files: ['dbghelp.dll', 'antigravity_proxy.dll', 'agy-acp-proxy.exe']
    }
  ];
}

function withFiles(plan, kind, files) {
  return plan.map(entry => (entry.kind === kind ? { ...entry, files: [...files] } : entry));
}

test('validateWindowsDeployPlan accepts a correctly separated plan', () => {
  assert.deepEqual(validateWindowsDeployPlan(makeWindowsPlan()), { valid: true });
});

test('validateWindowsDeployPlan rejects CLI-only DLLs in desktop and IDE targets', () => {
  for (const kind of ['desktop', 'ide']) {
    for (const forbidden of ['dbghelp.dll', 'antigravity_proxy.dll']) {
      const plan = withFiles(makeWindowsPlan(), kind, ['version.dll', forbidden]);
      assert.throws(
        () => validateWindowsDeployPlan(plan),
        new RegExp(`Refusing to deploy ${forbidden.replace('.', '\\.')} into the ${kind} target`)
      );
    }
  }
});

test('validateWindowsDeployPlan rejects version.dll in the CLI target', () => {
  const plan = withFiles(makeWindowsPlan(), 'cli', [
    'version.dll',
    'dbghelp.dll',
    'antigravity_proxy.dll'
  ]);
  assert.throws(() => validateWindowsDeployPlan(plan), /version\.dll is only valid for desktop\/IDE/);
});

test('validateWindowsDeployPlan requires version.dll in desktop and IDE targets', () => {
  for (const kind of ['desktop', 'ide']) {
    const plan = withFiles(makeWindowsPlan(), kind, []);
    assert.throws(() => validateWindowsDeployPlan(plan), /version\.dll is required/);
  }
});

test('validateWindowsDeployPlan requires both CLI DLLs', () => {
  const plan = withFiles(makeWindowsPlan(), 'cli', ['dbghelp.dll', 'agy-acp-proxy.exe']);
  assert.throws(() => validateWindowsDeployPlan(plan), /antigravity_proxy\.dll is required/);
});

/* ------------------------------------------------------------------ *
 * Connectivity
 * ------------------------------------------------------------------ */

function createSocks5Server() {
  return net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    let stage = 'greeting';

    socket.on('error', () => {});

    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);

      for (;;) {
        if (stage === 'greeting') {
          // 05 01 00 -> 05 00
          if (buffer.length < 3) return;
          if (buffer[0] !== 0x05) {
            socket.destroy();
            return;
          }
          buffer = buffer.subarray(3);
          socket.write(Buffer.from([0x05, 0x00]));
          stage = 'request';
          continue;
        }

        if (stage === 'request') {
          if (buffer.length < 4) return;

          const atyp = buffer[3];
          let length;
          if (atyp === 0x01) length = 4 + 4 + 2;
          else if (atyp === 0x04) length = 4 + 16 + 2;
          else if (atyp === 0x03) {
            if (buffer.length < 5) return;
            length = 5 + buffer[4] + 2;
          } else {
            socket.destroy();
            return;
          }

          if (buffer.length < length) return;
          buffer = buffer.subarray(length);
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
          stage = 'done';
          continue;
        }

        return;
      }
    });
  });
}

function createHttpConnectServer() {
  return net.createServer(socket => {
    socket.on('error', () => {});
    socket.once('data', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    });
  });
}

test('testProxyConnectivity completes a SOCKS5 handshake', async t => {
  const server = createSocks5Server();
  const port = await listen(server);
  t.after(() => closeServer(server));

  const result = await testProxyConnectivity(
    { proxy: { host: '127.0.0.1', port, type: 'socks5' } },
    { targetHost: '127.0.0.1', targetPort: 443, timeoutMs: 3000 }
  );

  assert.equal(result.ok, true);
  assert.equal(result.tcpReachable, true);
  assert.equal(result.handshakeOk, true);
  assert.equal(result.proxyPort, port);
  assert.equal(result.proxyType, 'socks5');
  assert.equal(result.error, null);
});

test('testProxyConnectivity completes an HTTP CONNECT handshake', async t => {
  const server = createHttpConnectServer();
  const port = await listen(server);
  t.after(() => closeServer(server));

  const result = await testProxyConnectivity(
    { proxy: { host: '127.0.0.1', port, type: 'http' } },
    { targetHost: '127.0.0.1', targetPort: 443, timeoutMs: 3000 }
  );

  assert.equal(result.ok, true);
  assert.equal(result.tcpReachable, true);
  assert.equal(result.handshakeOk, true);
  assert.equal(result.proxyPort, port);
  assert.equal(result.proxyType, 'http');
});

test('testProxyConnectivity reports a closed port as unreachable', async t => {
  const server = net.createServer();
  const port = await listen(server);
  await closeServer(server);
  t.after(() => closeServer(server));

  const result = await testProxyConnectivity(
    { proxy: { host: '127.0.0.1', port, type: 'socks5' } },
    { targetHost: '127.0.0.1', targetPort: 443, timeoutMs: 2000 }
  );

  assert.equal(result.ok, false);
  assert.equal(result.tcpReachable, false);
  assert.equal(result.handshakeOk, false);
  assert.ok(result.error);
});
