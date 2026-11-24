// End-to-end CLI tests. Each case spawns bin/agy-aio.mjs with HOME /
// USERPROFILE / LOCALAPPDATA / plugin dir redirected into a fresh mkdtemp
// sandbox so the real ~/.gemini, ~/.agy-aio and Antigravity install are not
// modified.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_ENTRY = path.join(REPO_ROOT, 'bin', 'agy-aio.mjs');

function makeSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-aio-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const tmpHome = path.join(root, 'home');
  const emptyAppDir = path.join(root, 'empty-antigravity');
  fs.mkdirSync(tmpHome, { recursive: true });
  fs.mkdirSync(emptyAppDir, { recursive: true });

  return {
    root,
    tmpHome,
    emptyAppDir,
    pluginsDir: path.join(tmpHome, 'plugins'),
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      LOCALAPPDATA: path.join(tmpHome, 'AppData', 'Local'),
      AGY_CAPSULE_PLUGINS_DIR: path.join(tmpHome, 'plugins'),
      NO_COLOR: '1'
    }
  };
}

function runCli(args, env) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 90000
  });
}

function outputOf(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

test('--help exits 0 and prints the tool name', t => {
  const sandbox = makeSandbox(t);
  const result = runCli(['--help'], sandbox.env);

  assert.equal(result.status, 0, outputOf(result));
  assert.match(result.stdout, /agy-aio/);
});

test('--version exits 0 and prints the package version', t => {
  const sandbox = makeSandbox(t);
  const result = runCli(['--version'], sandbox.env);

  assert.equal(result.status, 0, outputOf(result));
  assert.match(result.stdout, /1\.0\.0/);
});

test('status --json reports capsule, localization and proxy sections', t => {
  const sandbox = makeSandbox(t);
  const result = runCli(['status', '--json', '--app-dir', sandbox.emptyAppDir], sandbox.env);

  assert.equal(result.status, 0, outputOf(result));

  const report = JSON.parse(result.stdout);
  for (const key of ['capsule', 'localization', 'proxy']) {
    assert.ok(report[key], `status report must include "${key}"`);
    assert.equal(typeof report[key], 'object');
  }
});

test('install --dry-run --layers capsule writes no plugin files', t => {
  const sandbox = makeSandbox(t);
  const result = runCli(
    ['install', '--dry-run', '--yes', '--layers', 'capsule', '--app-dir', sandbox.emptyAppDir],
    sandbox.env
  );

  assert.equal(result.status, 0, outputOf(result));

  if (fs.existsSync(sandbox.pluginsDir)) {
    assert.deepEqual(fs.readdirSync(sandbox.pluginsDir), [], 'dry-run must not create plugin files');
  }
});

test('uninstall --dry-run --yes exits 0', t => {
  const sandbox = makeSandbox(t);
  const result = runCli(
    ['uninstall', '--dry-run', '--yes', '--app-dir', sandbox.emptyAppDir],
    sandbox.env
  );

  assert.equal(result.status, 0, outputOf(result));
});

test('unknown command exits 1', t => {
  const sandbox = makeSandbox(t);
  const result = runCli(['bogus-cmd'], sandbox.env);

  assert.equal(result.status, 1);
  assert.match(outputOf(result), /未知命令|bogus-cmd/);
});

test('unknown flag exits 1', t => {
  const sandbox = makeSandbox(t);
  const result = runCli(['status', '--bogus-flag'], sandbox.env);

  assert.equal(result.status, 1);
  assert.match(outputOf(result), /未知选项/);
});
