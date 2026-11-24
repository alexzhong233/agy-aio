// Unit tests for the pure helpers in scripts/sync-upstream.mjs. Nothing here
// touches git, the network, modules/ or THIRD-PARTY-NOTICES.md: every fixture
// lives in a fresh mkdtemp directory or plain strings.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SYNC_WHITELISTS,
  parseLsRemoteHead,
  copyWhitelistedTree,
  updateNoticesCommits,
  parseSyncArgs
} from '../scripts/sync-upstream.mjs';

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-aio-sync-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/* ------------------------------------------------------------------ *
 * parseLsRemoteHead
 * ------------------------------------------------------------------ */

test('parseLsRemoteHead extracts HEAD and ignores other refs', () => {
  const head = 'a'.repeat(40);
  const stdout = [
    `${'b'.repeat(40)}\trefs/heads/main`,
    `${head}\tHEAD`,
    `${'c'.repeat(40)}\trefs/tags/v1.0.0`
  ].join('\n');

  assert.equal(parseLsRemoteHead(stdout), head);
});

test('parseLsRemoteHead trims whitespace and lowercases the SHA', () => {
  const upper = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
  assert.equal(
    parseLsRemoteHead(`  ${upper}\tHEAD  \r\n`),
    upper.toLowerCase()
  );
});

test('parseLsRemoteHead returns null for invalid or empty output', () => {
  assert.equal(parseLsRemoteHead(''), null);
  assert.equal(parseLsRemoteHead('   \n\t\r\n'), null);
  assert.equal(parseLsRemoteHead('not-a-sha\tHEAD'), null);
  assert.equal(parseLsRemoteHead(`${'a'.repeat(39)}\tHEAD`), null);
  assert.equal(parseLsRemoteHead(`${'g'.repeat(40)}\tHEAD`), null);
  assert.equal(parseLsRemoteHead(`${'a'.repeat(40)}\trefs/heads/HEAD`), null);
  assert.equal(parseLsRemoteHead(null), null);
  assert.equal(parseLsRemoteHead(undefined), null);
});

/* ------------------------------------------------------------------ *
 * copyWhitelistedTree
 * ------------------------------------------------------------------ */

test('copyWhitelistedTree copies only whitelisted entries and drops stale files', t => {
  const root = makeRoot(t);
  const src = path.join(root, 'upstream');
  const dest = path.join(root, 'modules', 'localization');

  fs.mkdirSync(path.join(src, 'src'), { recursive: true });
  fs.mkdirSync(path.join(src, 'extracted'), { recursive: true });
  fs.mkdirSync(path.join(src, '.git'), { recursive: true });
  fs.writeFileSync(path.join(src, 'localize.js'), 'module.exports = "v2";\n', 'utf8');
  fs.writeFileSync(path.join(src, 'src', 'dict.js'), 'export const DICT = {};\n', 'utf8');
  fs.writeFileSync(path.join(src, 'extracted', 'huge.js'), 'x'.repeat(4096), 'utf8');
  fs.writeFileSync(path.join(src, 'app.asar.ready'), 'binary payload', 'utf8');
  fs.writeFileSync(path.join(src, '.git', 'HEAD'), 'ref: refs/heads/upstream\n', 'utf8');

  fs.mkdirSync(path.join(dest, 'old-subdir'), { recursive: true });
  fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'stale.txt'), 'old snapshot\n', 'utf8');
  fs.writeFileSync(path.join(dest, 'old-subdir', 'old.js'), 'old\n', 'utf8');
  fs.writeFileSync(path.join(dest, '.git', 'HEAD'), 'ref: refs/heads/keep\n', 'utf8');

  const result = copyWhitelistedTree(src, dest, SYNC_WHITELISTS.localization);

  assert.ok(result.copied.includes('localize.js'));
  assert.ok(result.copied.includes('src'));
  assert.ok(!result.copied.includes('extracted'));
  assert.ok(!result.copied.includes('app.asar.ready'));
  assert.ok(!result.copied.includes('.git'));

  assert.equal(fs.readFileSync(path.join(dest, 'localize.js'), 'utf8'), 'module.exports = "v2";\n');
  assert.equal(fs.readFileSync(path.join(dest, 'src', 'dict.js'), 'utf8'), 'export const DICT = {};\n');

  assert.equal(fs.existsSync(path.join(dest, 'stale.txt')), false);
  assert.equal(fs.existsSync(path.join(dest, 'old-subdir')), false);
  assert.equal(fs.existsSync(path.join(dest, 'extracted')), false);
  assert.equal(fs.existsSync(path.join(dest, 'app.asar.ready')), false);
  assert.equal(fs.existsSync(path.join(dest, '.git', 'HEAD')), true);
  assert.equal(fs.readFileSync(path.join(dest, '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/keep\n');
});

/* ------------------------------------------------------------------ *
 * updateNoticesCommits
 * ------------------------------------------------------------------ */

test('updateNoticesCommits rewrites the summary table and every Commit section', () => {
  const oldCapsule = '1'.repeat(40);
  const oldLocalization = '2'.repeat(40);
  const oldProxyPosix = '3'.repeat(40);
  const oldProxyWindows = '4'.repeat(40);

  const newCapsule = 'a'.repeat(40);
  const newLocalization = 'b'.repeat(40);
  const newProxyPosix = 'c'.repeat(40);
  const newProxyWindows = 'd'.repeat(40);

  const fixture = [
    '# Third-Party Notices',
    '',
    '| Project | Commit | License |',
    '| --- | --- | --- |',
    `| [Lumidarin/agy-capsule](https://github.com/Lumidarin/agy-capsule) | \`${oldCapsule}\` | MIT |`,
    `| [antigravity-cn-community/Antigravity-Chinese-Localization](https://github.com/antigravity-cn-community/Antigravity-Chinese-Localization) | \`${oldLocalization}\` | MIT |`,
    `| [xinayida/anti-proxy](https://github.com/xinayida/anti-proxy) | \`${oldProxyPosix}\` | Unspecified |`,
    `| [yuaotian/antigravity-proxy](https://github.com/yuaotian/antigravity-proxy) | \`${oldProxyWindows}\` | BSD-2-Clause |`,
    '',
    '---',
    '',
    '## 1. Lumidarin/agy-capsule',
    '',
    '- Repository: https://github.com/Lumidarin/agy-capsule',
    `- Commit: \`${oldCapsule}\``,
    '- License: MIT',
    '',
    '## 2. antigravity-cn-community/Antigravity-Chinese-Localization',
    '',
    '- Repository: https://github.com/antigravity-cn-community/Antigravity-Chinese-Localization',
    `- Commit: \`${oldLocalization}\``,
    '- License: MIT',
    '',
    '## 3. xinayida/anti-proxy',
    '',
    '- Repository: https://github.com/xinayida/anti-proxy',
    `- Commit: \`${oldProxyPosix}\``,
    '- License: Unspecified',
    '',
    '## 4. yuaotian/antigravity-proxy',
    '',
    '- Repository: https://github.com/yuaotian/antigravity-proxy',
    `- Commit: \`${oldProxyWindows}\``,
    '- License: BSD-2-Clause',
    ''
  ].join('\n');

  const updated = updateNoticesCommits(fixture, {
    capsule: newCapsule,
    localization: newLocalization,
    proxyPosix: newProxyPosix,
    proxyWindows: newProxyWindows
  });

  assert.notEqual(updated, fixture);

  for (const [oldSha, newSha] of [
    [oldCapsule, newCapsule],
    [oldLocalization, newLocalization],
    [oldProxyPosix, newProxyPosix],
    [oldProxyWindows, newProxyWindows]
  ]) {
    assert.equal(updated.includes(oldSha), false, `old SHA ${oldSha.slice(0, 8)} must be gone`);
    assert.equal(
      updated.split(newSha).length - 1,
      2,
      `new SHA ${newSha.slice(0, 8)} must appear in the table and the Commit line`
    );
  }

  // Every line without a commit SHA must be byte-for-byte untouched.
  const beforeLines = fixture.split('\n');
  const afterLines = updated.split('\n');
  assert.equal(afterLines.length, beforeLines.length);
  for (let index = 0; index < beforeLines.length; index += 1) {
    if (/`[0-9a-fA-F]{40}`/.test(beforeLines[index])) continue;
    assert.equal(afterLines[index], beforeLines[index], `line ${index + 1} changed`);
  }
});

test('updateNoticesCommits leaves the text alone without valid commits', () => {
  const text = '| [Lumidarin/agy-capsule](https://github.com/Lumidarin/agy-capsule) | `' + '1'.repeat(40) + '` | MIT |';

  assert.equal(updateNoticesCommits(text, {}), text);
  assert.equal(updateNoticesCommits(text, { capsule: 'not-a-sha' }), text);
  assert.equal(updateNoticesCommits(text, null), text);
});

/* ------------------------------------------------------------------ *
 * parseSyncArgs
 * ------------------------------------------------------------------ */

test('parseSyncArgs defaults to check mode with every module selected', () => {
  const options = parseSyncArgs([]);

  assert.equal(options.mode, 'check');
  assert.equal(options.apply, false);
  assert.equal(options.check, true);
  assert.equal(options.dryRun, false);
  assert.equal(options.noTest, false);
  assert.equal(options.help, false);
  assert.equal(options.only, null);
  assert.deepEqual(options.modules, ['capsule', 'localization', 'proxyPosix', 'proxyWindows']);
});

test('parseSyncArgs handles --apply, --only, --dry-run and --no-test', () => {
  const apply = parseSyncArgs(['--apply']);
  assert.equal(apply.mode, 'apply');
  assert.equal(apply.apply, true);
  assert.equal(apply.check, false);
  assert.equal(apply.only, null);

  const only = parseSyncArgs(['--only', 'l10n,proxy-posix,proxy-win']);
  assert.deepEqual(only.only, ['localization', 'proxyPosix', 'proxyWindows']);
  assert.deepEqual(only.modules, ['localization', 'proxyPosix', 'proxyWindows']);
  assert.equal(only.mode, 'check');

  const onlyEquals = parseSyncArgs(['--only=proxy-win,capsule']);
  assert.deepEqual(onlyEquals.modules, ['proxyWindows', 'capsule']);
  assert.deepEqual(onlyEquals.only, ['proxyWindows', 'capsule']);

  const flags = parseSyncArgs(['--dry-run', '--no-test']);
  assert.equal(flags.dryRun, true);
  assert.equal(flags.noTest, true);
  assert.equal(flags.mode, 'check');
});

test('parseSyncArgs rejects unknown flags', () => {
  assert.throws(() => parseSyncArgs(['--bogus']), /Unknown flag: --bogus/);
  assert.throws(() => parseSyncArgs(['--only', 'nope']), /Unknown module "nope"/);
  assert.throws(() => parseSyncArgs(['--only']), /--only requires/);
  assert.throws(() => parseSyncArgs(['stray']), /Unexpected argument: stray/);
});
