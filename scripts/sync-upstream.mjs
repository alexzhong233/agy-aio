#!/usr/bin/env node
// Synchronize the vendored slim snapshots under modules/ with their upstream
// GitHub repositories. Node.js >= 18.18.0, ESM, zero npm dependencies.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULES_DIR = path.join(REPO_ROOT, 'modules');
const VERSIONS_PATH = path.join(MODULES_DIR, 'upstream-versions.json');
const NOTICES_PATH = path.join(REPO_ROOT, 'THIRD-PARTY-NOTICES.md');
const CACHE_DIR = path.join(REPO_ROOT, '.cache');
const PROXY_POSIX_DIR = path.join(MODULES_DIR, 'proxy-posix');

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA_IN_BACKTICKS = /`[0-9a-fA-F]{40}`/;

export const SYNC_WHITELISTS = {
  capsule: [
    'agy-capsule',
    'scripts/manage-plugin.sh',
    'scripts/manage-plugin.ps1',
    'scripts/enable-cdp.ps1',
    'LICENSE',
    'README.md'
  ],
  localization: [
    'localize.js',
    'auto-restore.js',
    'asar-version.js',
    'package-installer.js',
    'process-check.js',
    'release-manager.js',
    'package.json',
    'LICENSE',
    'src'
  ],
  proxyPosix: [
    'include',
    'src',
    'tests',
    'Makefile',
    'CMakeLists.txt',
    'config.json',
    'README.md'
  ]
};

const SYNC_MODULES = ['capsule', 'localization', 'proxyPosix', 'proxyWindows'];

const MODULE_ALIASES = new Map([
  ['capsule', 'capsule'],
  ['localization', 'localization'],
  ['l10n', 'localization'],
  ['proxyposix', 'proxyPosix'],
  ['proxy-posix', 'proxyPosix'],
  ['proxy_posix', 'proxyPosix'],
  ['proxywindows', 'proxyWindows'],
  ['proxy-win', 'proxyWindows'],
  ['proxy-windows', 'proxyWindows'],
  ['proxy_win', 'proxyWindows'],
  ['proxy_windows', 'proxyWindows'],
  ['proxywin', 'proxyWindows']
]);

// URL path fragments as they appear in THIRD-PARTY-NOTICES.md.
const NOTICE_UPSTREAMS = [
  { key: 'capsule', urlPath: 'Lumidarin/agy-capsule' },
  { key: 'localization', urlPath: 'antigravity-cn-community/Antigravity-Chinese-Localization' },
  { key: 'proxyPosix', urlPath: 'xinayida/anti-proxy' },
  { key: 'proxyWindows', urlPath: 'yuaotian/antigravity-proxy' }
];

/* ------------------------------------------------------------------ *
 * Pure helpers (imported by test/sync-upstream.test.mjs)
 * ------------------------------------------------------------------ */

export function parseLsRemoteHead(stdout) {
  if (typeof stdout !== 'string') return null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = /^([0-9a-fA-F]{40})\s+HEAD(?:\s|$)/.exec(line);
    if (match) return match[1].toLowerCase();
  }

  return null;
}

function isSafeRelativeEntry(entry) {
  if (typeof entry !== 'string' || entry.trim() === '') return false;
  if (path.isAbsolute(entry)) return false;

  const parts = entry
    .replace(/\\/g, '/')
    .split('/')
    .filter(part => part !== '' && part !== '.');

  return parts.length > 0 && !parts.includes('..');
}

export function copyWhitelistedTree(srcDir, destDir, whitelist, { dryRun = false } = {}) {
  const entries = Array.isArray(whitelist) ? whitelist : [];
  const copied = [];
  const missing = [];

  for (const entry of entries) {
    if (!isSafeRelativeEntry(entry)) {
      throw new Error(`Invalid whitelist entry: ${JSON.stringify(entry)}`);
    }

    if (fs.existsSync(path.join(srcDir, entry))) copied.push(entry);
    else missing.push(entry);
  }

  if (copied.length === 0) {
    throw new Error(`No whitelisted files or directories found in ${srcDir}`);
  }

  if (dryRun) return { copied, missing };

  fs.mkdirSync(destDir, { recursive: true });

  // Drop the old snapshot, but never touch a .git directory if one is present.
  for (const name of fs.readdirSync(destDir)) {
    if (name === '.git') continue;
    fs.rmSync(path.join(destDir, name), { recursive: true, force: true });
  }

  for (const entry of copied) {
    const source = path.join(srcDir, entry);
    const target = path.join(destDir, entry);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, force: true, dereference: false });
  }

  return { copied, missing };
}

function commitOf(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && value.commit != null) return String(value.commit).trim();
  return '';
}

export function updateNoticesCommits(markdownText, versionsMap) {
  const text = String(markdownText ?? '');
  const map = versionsMap && typeof versionsMap === 'object' ? versionsMap : {};

  const commitsByUrl = new Map();
  for (const { key, urlPath } of NOTICE_UPSTREAMS) {
    const commit = commitOf(map[key]).toLowerCase();
    if (SHA_PATTERN.test(commit)) commitsByUrl.set(urlPath, commit);
  }

  if (commitsByUrl.size === 0) return text;

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let activeUrl = null;

  const lines = text.split(/\r?\n/).map(line => {
    for (const urlPath of commitsByUrl.keys()) {
      if (line.includes(urlPath)) {
        activeUrl = urlPath;
        break;
      }
    }

    let next = line;
    if (activeUrl) {
      next = line.replace(SHA_IN_BACKTICKS, `\`${commitsByUrl.get(activeUrl)}\``);
    }

    // A commit line closes the current project; a horizontal rule starts a new block.
    if (/^\s*-\s+Commit:/.test(line) || /^\s*---\s*$/.test(line)) activeUrl = null;

    return next;
  });

  return lines.join(eol);
}

function resolveModuleAlias(value) {
  const name = String(value ?? '').trim();
  if (!name) return null;
  return MODULE_ALIASES.get(name.toLowerCase()) || null;
}

export function parseSyncArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let apply = false;
  let dryRun = false;
  let noTest = false;
  let help = false;
  let selected = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);

    if (arg === '--apply') {
      apply = true;
      continue;
    }

    if (arg === '--check') {
      // --check is the default; --apply takes precedence if both are given.
      continue;
    }

    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (arg === '--no-test') {
      noTest = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }

    if (arg === '--only' || arg.startsWith('--only=')) {
      let value;
      if (arg === '--only') {
        index += 1;
        value = args[index];
        if (value == null || String(value).startsWith('-')) {
          throw new Error('--only requires a comma-separated module list');
        }
      } else {
        value = arg.slice('--only='.length);
      }

      const names = String(value)
        .split(',')
        .map(name => name.trim())
        .filter(Boolean);

      if (names.length === 0) {
        throw new Error('--only requires a comma-separated module list');
      }

      selected = selected || [];
      for (const name of names) {
        const resolved = resolveModuleAlias(name);
        if (!resolved) {
          throw new Error(
            `Unknown module "${name}" in --only (expected: ${SYNC_MODULES.join(', ')})`
          );
        }
        if (!selected.includes(resolved)) selected.push(resolved);
      }
      continue;
    }

    if (arg.startsWith('-')) throw new Error(`Unknown flag: ${arg}`);
    throw new Error(`Unexpected argument: ${arg}`);
  }

  const modules = selected ? selected.slice() : SYNC_MODULES.slice();

  return {
    mode: apply ? 'apply' : 'check',
    apply,
    check: !apply,
    dryRun,
    noTest,
    help,
    only: selected ? modules.slice() : null,
    modules
  };
}

/* ------------------------------------------------------------------ *
 * CLI helpers
 * ------------------------------------------------------------------ */

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never'
};

function git(args, { cwd = REPO_ROOT, timeout = 300000 } = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: GIT_ENV
  });
}

function cloneUrl(repo) {
  const value = String(repo ?? '').trim().replace(/\/+$/, '');
  return value.endsWith('.git') ? value : `${value}.git`;
}

function firstLine(error) {
  const stderr = error && error.stderr ? String(error.stderr).trim() : '';
  const message = stderr || (error && error.message) || String(error);
  return message.split(/\r?\n/).find(Boolean) || 'unknown error';
}

function fetchRemoteHead(repo) {
  return parseLsRemoteHead(git(['ls-remote', cloneUrl(repo), 'HEAD'], { timeout: 60000 }));
}

function cloneUpstream(repo, destination, extraArgs = []) {
  fs.rmSync(destination, { recursive: true, force: true });
  git(['clone', '--quiet', ...extraArgs, cloneUrl(repo), destination], { timeout: 600000 });
}

function hasCommit(repoDir, sha) {
  try {
    git(['cat-file', '-e', `${sha}^{commit}`], { cwd: repoDir, timeout: 60000 });
    return true;
  } catch {
    return false;
  }
}

function ensureCommit(repoDir, sha) {
  if (hasCommit(repoDir, sha)) return;

  try {
    git(['fetch', '--filter=blob:none', 'origin', sha], { cwd: repoDir, timeout: 600000 });
  } catch {
    // Fall back to fetching all advertised refs below.
  }

  if (hasCommit(repoDir, sha)) return;

  try {
    git(['fetch', '--filter=blob:none', 'origin'], { cwd: repoDir, timeout: 600000 });
  } catch {
    // The commit may still be present from the initial clone.
  }

  if (!hasCommit(repoDir, sha)) {
    throw new Error(`Upstream commit ${sha} is not available in the local clone`);
  }
}

function gitIndexPath() {
  try {
    const value = git(['rev-parse', '--git-path', 'index'], { timeout: 60000 }).trim();
    return path.isAbsolute(value) ? value : path.join(REPO_ROOT, value);
  } catch {
    return null;
  }
}

function printTable(headers, rows) {
  const matrix = [headers, ...rows].map(row => row.map(value => String(value ?? '')));
  const widths = headers.map((_, index) =>
    Math.max(0, ...matrix.map(row => (row[index] || '').length))
  );

  const formatRow = row =>
    row
      .map((cell, index) => String(cell ?? '').padEnd(widths[index]))
      .join('  ')
      .replace(/\s+$/, '');

  console.log(formatRow(matrix[0]));
  console.log(widths.map(width => '-'.repeat(width)).join('  '));
  for (let index = 1; index < matrix.length; index += 1) console.log(formatRow(matrix[index]));
}

function printUsage() {
  console.log(`Usage: node scripts/sync-upstream.mjs [options]

Options:
  --check              Compare locked commits with upstream HEAD (default)
  --apply              Sync upstream sources into modules/
  --only <list>        Comma-separated modules: capsule, localization,
                       proxy-posix, proxy-win
  --dry-run            Show what --apply would change without writing anything
  --no-test            Skip "node --test test/*.test.mjs" after a real sync
  --help, -h           Show this help

Examples:
  node scripts/sync-upstream.mjs
  node scripts/sync-upstream.mjs --apply
  node scripts/sync-upstream.mjs --apply --only l10n,capsule
  node scripts/sync-upstream.mjs --apply --only proxy-posix --dry-run`);
}

function loadVersions() {
  if (!fs.existsSync(VERSIONS_PATH)) {
    throw new Error(`Missing ${path.relative(REPO_ROOT, VERSIONS_PATH)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(VERSIONS_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot parse ${path.relative(REPO_ROOT, VERSIONS_PATH)}: ${error.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path.relative(REPO_ROOT, VERSIONS_PATH)} must contain a JSON object`);
  }

  return parsed;
}

function writeVersions(versions) {
  fs.writeFileSync(VERSIONS_PATH, `${JSON.stringify(versions, null, 2)}\n`, 'utf8');
}

function writeNotices(versions) {
  if (!fs.existsSync(NOTICES_PATH)) return;

  const before = fs.readFileSync(NOTICES_PATH, 'utf8');
  const after = updateNoticesCommits(before, versions);
  if (after !== before) fs.writeFileSync(NOTICES_PATH, after, 'utf8');
}

function runTestSuite() {
  const testDir = path.join(REPO_ROOT, 'test');
  let names = [];

  try {
    names = fs
      .readdirSync(testDir)
      .filter(name => name.endsWith('.test.mjs'))
      .sort();
  } catch {
    // No test directory is not an error here.
  }

  if (names.length === 0) {
    console.log('\n! No test/*.test.mjs files found; skipping the test suite.');
    return 0;
  }

  console.log('\n$ node --test test/*.test.mjs');
  const result = spawnSync(
    process.execPath,
    ['--test', ...names.map(name => path.join('test', name))],
    { cwd: REPO_ROOT, stdio: 'inherit', env: process.env }
  );

  if (result.error) {
    console.log(`x Failed to run tests: ${result.error.message}`);
    return 1;
  }

  return typeof result.status === 'number' ? result.status : 1;
}

/* ------------------------------------------------------------------ *
 * Sync operations
 * ------------------------------------------------------------------ */

function syncWhitelistedModule(key, entry, upstreamSha, staging, options, updates) {
  const lockedSha = commitOf(entry).toLowerCase();

  if (lockedSha === upstreamSha) {
    console.log(`- ${key}: already at ${upstreamSha}`);
    return true;
  }

  const stageDir = path.join(staging, key);
  const destDir = path.join(MODULES_DIR, key);

  try {
    cloneUpstream(entry.repo, stageDir, ['--depth', '1']);

    const result = copyWhitelistedTree(stageDir, destDir, SYNC_WHITELISTS[key], {
      dryRun: options.dryRun
    });

    if (result.missing.length > 0) {
      console.log(`! ${key}: whitelisted paths missing upstream: ${result.missing.join(', ')}`);
    }

    const action = options.dryRun ? '[dry-run] would copy' : 'copied';
    console.log(`- ${key}: ${action} ${result.copied.join(', ')} (${lockedSha.slice(0, 12)} -> ${upstreamSha.slice(0, 12)})`);

    if (!options.dryRun) updates.set(key, upstreamSha);
    return true;
  } catch (error) {
    console.log(`x ${key}: ${firstLine(error)}`);
    return false;
  }
}

function syncProxyWindows(entry, upstreamSha, options, updates) {
  const lockedSha = commitOf(entry).toLowerCase();

  if (lockedSha === upstreamSha) {
    console.log(`- proxyWindows: already at ${upstreamSha}`);
    return;
  }

  if (options.dryRun) {
    console.log(`- proxyWindows: [dry-run] would record ${upstreamSha} (DLLs come from GitHub Releases)`);
    return;
  }

  updates.set('proxyWindows', upstreamSha);
  console.log(`- proxyWindows: recorded ${upstreamSha} (DLLs come from GitHub Releases at install time)`);
}

function restoreProxyPosix(backupDir, existed) {
  if (existed) {
    fs.rmSync(PROXY_POSIX_DIR, { recursive: true, force: true });
    fs.cpSync(backupDir, PROXY_POSIX_DIR, {
      recursive: true,
      force: true,
      dereference: false
    });
  } else {
    fs.rmSync(PROXY_POSIX_DIR, { recursive: true, force: true });
  }
}

function applyProxyPosixPatch(patchText, upstreamSha, staging, updates) {
  const patchPath = path.join(staging, 'proxy-posix-upstream.patch');
  const backupDir = path.join(staging, 'proxy-posix-backup');
  const existed = fs.existsSync(PROXY_POSIX_DIR);

  fs.writeFileSync(patchPath, patchText, 'utf8');
  if (existed) {
    fs.cpSync(PROXY_POSIX_DIR, backupDir, {
      recursive: true,
      force: true,
      dereference: false
    });
  }

  // Keep the user's index untouched even if "git apply --3way" leaves conflict stages.
  const indexPath = gitIndexPath();
  const indexBackup = path.join(staging, 'index.backup');
  const hasIndexBackup = Boolean(indexPath && fs.existsSync(indexPath));
  if (hasIndexBackup) fs.copyFileSync(indexPath, indexBackup);

  try {
    git(['apply', '--3way', '--directory=modules/proxy-posix', patchPath], {
      cwd: REPO_ROOT,
      timeout: 120000
    });

    updates.set('proxyPosix', upstreamSha);
    console.log(`- proxyPosix: applied upstream patch cleanly (${upstreamSha})`);
    return true;
  } catch (error) {
    try {
      restoreProxyPosix(backupDir, existed);
      if (hasIndexBackup) fs.copyFileSync(indexBackup, indexPath);
    } catch (restoreError) {
      console.log(`x proxyPosix: failed to restore modules/proxy-posix: ${restoreError.message}`);
    }

    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const cachedPatch = path.join(CACHE_DIR, 'proxy-posix-upstream.patch');
    fs.writeFileSync(cachedPatch, patchText, 'utf8');

    console.log(`x proxyPosix: upstream patch did not apply cleanly (${firstLine(error)})`);
    console.log('  modules/proxy-posix/ was left unchanged and its commit was NOT updated.');
    console.log(`  Patch written to: ${path.relative(REPO_ROOT, cachedPatch)}`);
    console.log('  Manual merge instructions:');
    console.log('    1. Review the patch above and compare it with modules/proxy-posix/.');
    console.log('    2. Merge the relevant upstream changes by hand, keeping the Linux');
    console.log('       LD_PRELOAD port and the offline mock tests intact.');
    console.log('    3. Re-run: node scripts/sync-upstream.mjs --apply --only proxy-posix');
    return false;
  }
}

function syncProxyPosix(entry, upstreamSha, staging, options, updates) {
  const lockedSha = commitOf(entry).toLowerCase();

  if (!SHA_PATTERN.test(lockedSha)) {
    console.log(`x proxyPosix: locked commit is missing or invalid; cannot compute an upstream diff`);
    return false;
  }

  if (lockedSha === upstreamSha) {
    console.log(`- proxyPosix: already at ${upstreamSha}`);
    return true;
  }

  const stageDir = path.join(staging, 'proxy-posix');

  try {
    cloneUpstream(entry.repo, stageDir, ['--filter=blob:none']);
    ensureCommit(stageDir, lockedSha);
    ensureCommit(stageDir, upstreamSha);
  } catch (error) {
    console.log(`x proxyPosix: ${firstLine(error)}`);
    return false;
  }

  const pathspec = SYNC_WHITELISTS.proxyPosix;
  let patchText;
  try {
    patchText = git(
      ['diff', '--no-color', '--no-ext-diff', lockedSha, upstreamSha, '--', ...pathspec],
      { cwd: stageDir, timeout: 120000 }
    );
  } catch (error) {
    console.log(`x proxyPosix: git diff failed: ${firstLine(error)}`);
    return false;
  }

  if (!patchText.trim()) {
    console.log(
      `- proxyPosix: upstream changed only outside tracked paths; updating SHA (${lockedSha.slice(0, 12)} -> ${upstreamSha.slice(0, 12)})`
    );
    if (!options.dryRun) updates.set('proxyPosix', upstreamSha);
    return true;
  }

  console.log(`- proxyPosix: upstream changes detected in tracked paths:`);
  try {
    const stat = git(
      ['diff', '--stat', '--no-color', lockedSha, upstreamSha, '--', ...pathspec],
      { cwd: stageDir, timeout: 120000 }
    );
    if (stat.trim()) console.log(stat.trimEnd());
  } catch {
    // The file list is only informational.
  }

  if (options.dryRun) {
    console.log('  [dry-run] modules/proxy-posix/ left untouched; no SHA was written.');
    return true;
  }

  return applyProxyPosixPatch(patchText, upstreamSha, staging, updates);
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export function runSyncUpstream(argv) {
  let options;
  try {
    options = parseSyncArgs(argv);
  } catch (error) {
    console.log(`x ${error.message}`);
    console.log('Run with --help for usage.');
    return 2;
  }

  if (options.help) {
    printUsage();
    return 0;
  }

  const versions = loadVersions();
  const rows = [];
  const heads = new Map();

  for (const key of options.modules) {
    const entry = versions[key];
    const lockedSha = entry ? commitOf(entry).toLowerCase() : '';
    let upstreamSha = null;
    let failure = '';

    if (!entry || typeof entry.repo !== 'string' || !entry.repo.trim()) {
      failure = 'no repository URL';
    } else {
      try {
        upstreamSha = fetchRemoteHead(entry.repo);
        if (!upstreamSha) failure = 'invalid ls-remote output';
      } catch (error) {
        failure = firstLine(error);
      }
    }

    heads.set(key, upstreamSha);

    let status;
    if (failure) status = 'fetch-failed';
    else if (!SHA_PATTERN.test(lockedSha)) status = 'invalid-locked-sha';
    else if (lockedSha === upstreamSha) status = 'up-to-date';
    else status = 'update-available';

    rows.push([key, lockedSha || '-', upstreamSha || '-', status]);
  }

  console.log('');
  printTable(['module', 'locked', 'upstream', 'status'], rows);

  if (!options.apply) {
    console.log('\n运行 node scripts/sync-upstream.mjs --apply 同步最新源码');
    return 0;
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-aio-sync-'));
  const updates = new Map();
  let hadError = false;

  try {
    console.log('');

    for (const key of options.modules) {
      const entry = versions[key];
      const upstreamSha = heads.get(key);

      if (!entry || !upstreamSha) {
        console.log(`! ${key}: skipped because the upstream HEAD could not be resolved`);
        hadError = true;
        continue;
      }

      if (key === 'proxyWindows') {
        syncProxyWindows(entry, upstreamSha, options, updates);
        continue;
      }

      if (key === 'proxyPosix') {
        if (!syncProxyPosix(entry, upstreamSha, staging, options, updates)) hadError = true;
        continue;
      }

      if (!syncWhitelistedModule(key, entry, upstreamSha, staging, options, updates)) {
        hadError = true;
      }
    }

    if (options.dryRun) {
      console.log('\nDry run complete: no files were modified.');
      return hadError ? 1 : 0;
    }

    if (updates.size === 0) {
      console.log('\nNothing to update; modules/upstream-versions.json was not changed.');
      return hadError ? 1 : 0;
    }

    for (const [key, sha] of updates) {
      versions[key].commit = sha;
    }

    writeVersions(versions);
    writeNotices(versions);

    console.log(`\nUpdated ${updates.size} module(s): ${[...updates.keys()].join(', ')}`);

    if (!options.noTest) {
      const testStatus = runTestSuite();
      if (testStatus !== 0) return testStatus;
    }

    return hadError ? 1 : 0;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

const isMainModule =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  try {
    process.exitCode = runSyncUpstream(process.argv.slice(2));
  } catch (error) {
    console.log(`x ${error.message}`);
    process.exitCode = 1;
  }
}
