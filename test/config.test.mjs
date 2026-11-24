// Isolated tests for lib/config.mjs. Config paths are always inside a
// per-test mkdtemp directory; the real ~/.agy-aio is never referenced.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getDefaultConfig,
  loadConfig,
  saveConfig,
  updateProxyEndpoint,
  syncConfigToTarget
} from '../lib/config.mjs';

function makeRoot(t, prefix = 'agy-aio-config-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makePlatformInfo(root) {
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  return {
    os: process.platform,
    arch: process.arch,
    isRoot: false,
    realUserHome: home,
    realUid: null,
    realGid: null,
    dataDir: path.join(home, '.agy-aio')
  };
}

test('getDefaultConfig returns the expected proxy, fake_ip, processes and rules', () => {
  const config = getDefaultConfig();

  assert.deepEqual(config.proxy, { host: '127.0.0.1', port: 7890, type: 'socks5' });
  assert.equal(config.fake_ip.enabled, true);
  assert.equal(config.fake_ip.cidr, '198.18.0.0/15');

  for (const name of [
    'language_server_macos_arm',
    'language_server_macos_x64',
    'language_server_windows_x64.exe',
    'language_server_linux_x64',
    'language_server_linux_arm64',
    'Antigravity',
    'Antigravity.exe',
    'agy'
  ]) {
    assert.ok(
      config.target_processes.includes(name),
      `target_processes should include ${name}`
    );
  }

  assert.deepEqual(config.proxy_rules.allowed_ports, [80, 443]);
  assert.equal(config.proxy_rules.dns_mode, 'direct');
  assert.equal(config.proxy_rules.routing.default_action, 'proxy');
  assert.ok(Array.isArray(config.proxy_rules.routing.rules));
  assert.ok(
    config.proxy_rules.routing.rules.some(rule => rule.name === 'Bypass Localhost')
  );
});

test('loadConfig reports a missing file and returns defaults', t => {
  const root = makeRoot(t);
  const configPath = path.join(root, 'data', 'config.json');

  const result = loadConfig(configPath);

  assert.equal(result.exists, false);
  assert.equal(result.path, configPath);
  assert.deepEqual(result.config, getDefaultConfig());
});

test('saveConfig then loadConfig preserves custom rules and processes', t => {
  const root = makeRoot(t);
  const platformInfo = makePlatformInfo(root);
  const configPath = path.join(platformInfo.dataDir, 'config.json');

  const custom = getDefaultConfig();
  custom.target_processes = ['custom-proc', 'agy'];
  custom.proxy_rules = {
    allowed_ports: [8080],
    dns_mode: 'proxy',
    ipv6_mode: 'direct',
    routing: { default_action: 'direct', rules: [] }
  };

  saveConfig(custom, configPath, platformInfo);
  const result = loadConfig(configPath);

  assert.equal(result.exists, true);
  assert.deepEqual(result.config.target_processes, ['custom-proc', 'agy']);
  assert.deepEqual(result.config.proxy_rules, custom.proxy_rules);
});

test('updateProxyEndpoint accepts a valid host, port and type', () => {
  const next = updateProxyEndpoint(getDefaultConfig(), {
    host: ' 0.0.0.0 ',
    port: '8080',
    type: 'http'
  });

  assert.equal(next.proxy.host, '0.0.0.0');
  assert.equal(next.proxy.port, 8080);
  assert.equal(typeof next.proxy.port, 'number');
  assert.equal(next.proxy.type, 'http');
});

test('updateProxyEndpoint rejects invalid ports', () => {
  const config = getDefaultConfig();
  for (const port of [0, 70000, 12.5]) {
    assert.throws(() => updateProxyEndpoint(config, { port }), RangeError, `port ${port}`);
  }
});

test('updateProxyEndpoint rejects an invalid type', () => {
  assert.throws(() => updateProxyEndpoint(getDefaultConfig(), { type: 'ftp' }), TypeError);
});

test('updateProxyEndpoint rejects an empty host', () => {
  assert.throws(() => updateProxyEndpoint(getDefaultConfig(), { host: '' }), TypeError);
  assert.throws(() => updateProxyEndpoint(getDefaultConfig(), { host: '   ' }), TypeError);
});

test('syncConfigToTarget writes config.json when it is missing', t => {
  const root = makeRoot(t);
  const platformInfo = makePlatformInfo(root);
  const targetDir = path.join(root, 'target');
  const config = getDefaultConfig();

  const result = syncConfigToTarget(targetDir, config, { platformInfo });

  assert.equal(result.written, true);
  assert.equal(result.path, path.join(targetDir, 'config.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(result.path, 'utf8')), config);
});

test('syncConfigToTarget respects an existing config when force is false', t => {
  const root = makeRoot(t);
  const platformInfo = makePlatformInfo(root);
  const targetDir = path.join(root, 'target');
  fs.mkdirSync(targetDir, { recursive: true });
  const configPath = path.join(targetDir, 'config.json');
  const existing = { marker: 'keep-me' };
  fs.writeFileSync(configPath, JSON.stringify(existing));

  const result = syncConfigToTarget(targetDir, getDefaultConfig(), {
    force: false,
    platformInfo
  });

  assert.equal(result.written, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), existing);
});

test('syncConfigToTarget overwrites an existing config when force is true', t => {
  const root = makeRoot(t);
  const platformInfo = makePlatformInfo(root);
  const targetDir = path.join(root, 'target');
  fs.mkdirSync(targetDir, { recursive: true });
  const configPath = path.join(targetDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ marker: 'old' }));

  const config = getDefaultConfig();
  config.proxy.port = 9999;
  const result = syncConfigToTarget(targetDir, config, { force: true, platformInfo });

  assert.equal(result.written, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), config);
});
