// Offline unit tests for lib/version.mjs and GitHub release web-fallback in lib/net.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { normalizeVersionTag, compareVersions } from '../lib/version.mjs';
import { getLatestRelease, getLatestReleaseFromWeb, parseExpandedAssetsHtml } from '../lib/net.mjs';

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

test('normalizeVersionTag trims whitespace and strips leading v', () => {
  assert.equal(normalizeVersionTag(' v1.5.2 '), '1.5.2');
  assert.equal(normalizeVersionTag('V2.35.0'), '2.35.0');
  assert.equal(normalizeVersionTag('2.34.0.1'), '2.34.0.1');
  assert.equal(normalizeVersionTag(null), '');
});

test('compareVersions compares 3-part, 4-part, multi-digit and prerelease versions', () => {
  assert.equal(compareVersions('v1.5.2', '1.5.1'), 1);
  assert.equal(compareVersions('1.5.2', 'v1.5.2'), 0);
  assert.equal(compareVersions('v2.6.6', 'v2.10.0'), -1);
  assert.equal(compareVersions('2.34.0.1', '2.34.0'), 1);
  assert.equal(compareVersions('2.35.0', '2.34.0.1'), 1);
  assert.equal(compareVersions('1.5.2', '1.5.2-beta.1'), 1);
  assert.equal(compareVersions('1.5.2-alpha.2', '1.5.2-alpha.10'), -1);
  assert.equal(compareVersions('1.5.2-1', '1.5.2-alpha'), -1);
  assert.equal(compareVersions('1.5.2+build1', '1.5.2+build2'), 0);
  assert.equal(compareVersions('invalid', '1.0.0'), null);
  assert.equal(compareVersions('', '1.0.0'), null);
});

test('parseExpandedAssetsHtml extracts and deduplicates release download links', () => {
  const html = `
    <ul>
      <li><a href="/owner/repo/releases/download/v2.35.0/app.asar.ready">app.asar.ready</a></li>
      <li><a href='/owner/repo/releases/download/v2.35.0/SHA256SUMS.txt'>SHA256SUMS.txt</a></li>
      <li><a href="/owner/repo/releases/download/v2.35.0/app.asar.ready?download=1">dup</a></li>
      <li><a href="/other/repo/releases/download/v1.0.0/ignored.zip">ignored</a></li>
      <li><a href="/owner/repo/releases/download/v2.35.0/my%20file.zip">decoded</a></li>
    </ul>
  `;

  const assets = parseExpandedAssetsHtml(html, 'owner/repo', 'https://github.com');
  assert.deepEqual(assets, [
    {
      name: 'app.asar.ready',
      url: 'https://github.com/owner/repo/releases/download/v2.35.0/app.asar.ready',
      size: null
    },
    {
      name: 'SHA256SUMS.txt',
      url: 'https://github.com/owner/repo/releases/download/v2.35.0/SHA256SUMS.txt',
      size: null
    },
    {
      name: 'my file.zip',
      url: 'https://github.com/owner/repo/releases/download/v2.35.0/my%20file.zip',
      size: null
    }
  ]);
});

test('getLatestRelease prefers web without token and skips API requests', async t => {
  let apiCalls = 0;

  const server = http.createServer((req, res) => {
    if (req.url === '/owner/repo/releases/latest') {
      res.writeHead(302, { Location: '/owner/repo/releases/tag/v2.35.0' });
      res.end();
      return;
    }
    if (req.url === '/owner/repo/releases/expanded_assets/v2.35.0') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <a href="/owner/repo/releases/download/v2.35.0/app.asar.ready">app.asar.ready</a>
        <a href="/owner/repo/releases/download/v2.35.0/SHA256SUMS.txt">SHA256SUMS.txt</a>
      `);
      return;
    }
    if (req.url.startsWith('/repos/')) {
      apiCalls += 1;
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'API rate limit exceeded' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const port = await listen(server);
  t.after(() => closeServer(server));
  const base = `http://127.0.0.1:${port}`;

  const release = await getLatestRelease('owner/repo', {
    env: {},
    apiBaseUrl: base,
    webBaseUrl: base
  });

  assert.equal(apiCalls, 0);
  assert.equal(release.source, 'web');
  assert.equal(release.tag, 'v2.35.0');
  assert.equal(release.tarballUrl, `${base}/owner/repo/archive/refs/tags/v2.35.0.tar.gz`);
  assert.equal(release.zipballUrl, `${base}/owner/repo/archive/refs/tags/v2.35.0.zip`);
  assert.equal(release.assets.length, 2);
  assert.equal(release.assets[0].name, 'app.asar.ready');
  assert.equal(release.assets[1].name, 'SHA256SUMS.txt');
});

test('getLatestRelease falls back to web when tokened API returns 403 rate limit', async t => {
  let apiCalls = 0;

  const server = http.createServer((req, res) => {
    if (req.url === '/repos/owner/repo/releases/latest') {
      apiCalls += 1;
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'API rate limit exceeded' }));
      return;
    }
    if (req.url === '/owner/repo/releases/latest') {
      res.writeHead(302, { Location: 'https://github.com/owner/repo/releases/tag/v1.5.2' });
      res.end();
      return;
    }
    if (req.url === '/owner/repo/releases/expanded_assets/v1.5.2') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const port = await listen(server);
  t.after(() => closeServer(server));
  const base = `http://127.0.0.1:${port}`;

  const release = await getLatestRelease('owner/repo', {
    env: { GITHUB_TOKEN: 'dummy-token' },
    apiBaseUrl: base,
    webBaseUrl: base
  });

  assert.equal(apiCalls, 1);
  assert.equal(release.source, 'web');
  assert.equal(release.tag, 'v1.5.2');
  assert.deepEqual(release.assets, []);
});

test('getLatestRelease falls back to API when web lookup fails', async t => {
  let webCalls = 0;
  let apiCalls = 0;

  const server = http.createServer((req, res) => {
    if (req.url === '/owner/repo/releases/latest') {
      webCalls += 1;
      res.writeHead(500);
      res.end('server error');
      return;
    }
    if (req.url === '/repos/owner/repo/releases/latest') {
      apiCalls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          tag_name: 'v2.6.6',
          name: 'Release 2.6.6',
          tarball_url: 'https://example.invalid/tar',
          zipball_url: 'https://example.invalid/zip',
          assets: [
            {
              name: 'SHA256SUMS.txt',
              browser_download_url: 'https://example.invalid/SHA256SUMS.txt',
              size: 128
            }
          ]
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const port = await listen(server);
  t.after(() => closeServer(server));
  const base = `http://127.0.0.1:${port}`;

  const release = await getLatestRelease('owner/repo', {
    env: {},
    apiBaseUrl: base,
    webBaseUrl: base
  });

  assert.equal(webCalls, 1);
  assert.equal(apiCalls, 1);
  assert.equal(release.source, 'api');
  assert.equal(release.tag, 'v2.6.6');
  assert.equal(release.assets[0].name, 'SHA256SUMS.txt');

  await assert.rejects(
    getLatestReleaseFromWeb('owner/repo', { webBaseUrl: base }),
    /HTTP 500/
  );
});
