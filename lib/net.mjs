// Network and archive helpers. Node built-ins only.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const USER_AGENT = 'agy-aio/1.0';

function githubToken(env) {
  return env && (env.GITHUB_TOKEN || env.GH_TOKEN);
}

function buildHeaders(url, headers, env) {
  const result = { 'User-Agent': USER_AGENT, ...headers };
  const token = githubToken(env);
  if (token && String(url).startsWith('https://api.github.com/')) {
    const hasAuth = Object.keys(result).some(key => key.toLowerCase() === 'authorization');
    if (!hasAuth) result.Authorization = `Bearer ${token}`;
  }
  return result;
}

async function responseError(response, url) {
  let detail = '';
  try {
    detail = (await response.text()).trim().slice(0, 300);
  } catch {
    // Response body may be unreadable.
  }
  const error = new Error(
    `HTTP ${response.status} ${response.statusText || ''} for ${url}${detail ? `: ${detail}` : ''}`.trim()
  );
  error.status = response.status;
  return error;
}

export async function fetchJson(url, { timeoutMs = 15000, headers = {}, env = process.env, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    headers: buildHeaders(url, headers, env),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) throw await responseError(response, url);
  return response.json();
}

export async function downloadFile(url, destPath, { timeoutMs = 60000, headers = {}, env = process.env } = {}) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const partPath = `${destPath}.part.${process.pid}`;

  try {
    const response = await fetch(url, {
      headers: buildHeaders(url, headers, env),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) throw await responseError(response, url);

    if (response.body) {
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partPath));
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(partPath, buffer);
    }

    fs.renameSync(partPath, destPath);
    return destPath;
  } catch (error) {
    try {
      fs.rmSync(partPath, { force: true });
    } catch {
      // Best-effort cleanup of the partial download.
    }
    throw error;
  }
}

export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function parseSha256Sums(sumsText) {
  const result = new Map();
  const lines = String(sumsText ?? '').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);
    if (!match) continue;

    const digest = match[1].toLowerCase();
    const fileName = match[2].trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!fileName) continue;

    result.set(fileName, digest);
    const baseName = fileName.split('/').pop();
    if (baseName && !result.has(baseName)) result.set(baseName, digest);
  }

  return result;
}

export async function verifySha256Sums(filePath, assetName, sumsText) {
  const actual = await sha256File(filePath);
  const parsed = parseSha256Sums(sumsText);
  const key = String(assetName ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  const expected =
    parsed.get(key) ||
    parsed.get(path.basename(key)) ||
    parsed.get(String(assetName ?? '')) ||
    null;

  return {
    ok: Boolean(expected && expected === actual),
    expected,
    actual
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseExpandedAssetsHtml(html, ownerRepo, webBaseUrl = 'https://github.com') {
  const repo = String(ownerRepo ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!repo) return [];

  const base = String(webBaseUrl || 'https://github.com').replace(/\/+$/, '');
  const pattern = new RegExp(
    `href=["'](\\/${escapeRegExp(repo)}\\/releases\\/download\\/[^"'?#]+)["']`,
    'gi'
  );

  const seen = new Set();
  const assets = [];
  const source = String(html ?? '');

  for (const match of source.matchAll(pattern)) {
    const href = match[1];
    const rawName = href.split('/').pop() || '';
    let name = rawName;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      // Keep the raw segment if percent-decoding fails.
    }
    if (!name || seen.has(name)) continue;
    seen.add(name);
    assets.push({
      name,
      url: new URL(href, `${base}/`).toString(),
      size: null
    });
  }

  return assets;
}

export async function getLatestReleaseFromWeb(
  ownerRepo,
  { timeoutMs = 15000, fetchImpl = fetch, webBaseUrl = 'https://github.com' } = {}
) {
  const repo = String(ownerRepo ?? '').trim().replace(/^\/+|\/+$/g, '');
  const base = String(webBaseUrl || 'https://github.com').replace(/\/+$/, '');
  const latestUrl = `${base}/${repo}/releases/latest`;

  const response = await fetchImpl(latestUrl, {
    redirect: 'manual',
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (response.status >= 400) {
    throw await responseError(response, latestUrl);
  }

  const location = response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('location') || ''
    : '';
  const candidate = location || response.url || '';
  const tagMatch = /\/releases\/tag\/([^/?#]+)/.exec(candidate);
  if (!tagMatch) {
    throw new Error(`No GitHub release tag found for ${ownerRepo}`);
  }

  let tag = tagMatch[1];
  try {
    tag = decodeURIComponent(tag);
  } catch {
    // Keep raw tag if percent-decoding fails.
  }

  const encodedTag = encodeURIComponent(tag);
  let assets = [];
  try {
    const assetsUrl = `${base}/${repo}/releases/expanded_assets/${encodedTag}`;
    const assetsResponse = await fetchImpl(assetsUrl, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (assetsResponse.ok) {
      assets = parseExpandedAssetsHtml(await assetsResponse.text(), repo, base);
    }
  } catch {
    // Source-only releases or transient expanded_assets failures still leave tarballUrl/zipballUrl usable.
  }

  return {
    tag,
    name: tag,
    tarballUrl: `${base}/${repo}/archive/refs/tags/${encodedTag}.tar.gz`,
    zipballUrl: `${base}/${repo}/archive/refs/tags/${encodedTag}.zip`,
    assets,
    source: 'web'
  };
}

async function getLatestReleaseFromApi(
  ownerRepo,
  { timeoutMs = 15000, env = process.env, fetchImpl = fetch, apiBaseUrl = 'https://api.github.com' } = {}
) {
  const apiBase = String(apiBaseUrl || 'https://api.github.com').replace(/\/+$/, '');
  const data = await fetchJson(`${apiBase}/repos/${ownerRepo}/releases/latest`, {
    timeoutMs,
    env,
    fetchImpl
  });

  return {
    tag: data.tag_name,
    name: data.name || data.tag_name,
    tarballUrl: data.tarball_url,
    zipballUrl: data.zipball_url,
    assets: (data.assets || []).map(asset => ({
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size
    })),
    source: 'api'
  };
}

export async function getLatestRelease(
  ownerRepo,
  {
    timeoutMs = 15000,
    env = process.env,
    fetchImpl = fetch,
    apiBaseUrl = 'https://api.github.com',
    webBaseUrl = 'https://github.com'
  } = {}
) {
  const hasToken = Boolean(githubToken(env));

  if (hasToken) {
    try {
      return await getLatestReleaseFromApi(ownerRepo, { timeoutMs, env, fetchImpl, apiBaseUrl });
    } catch (apiError) {
      try {
        return await getLatestReleaseFromWeb(ownerRepo, { timeoutMs, fetchImpl, webBaseUrl });
      } catch {
        throw apiError;
      }
    }
  }

  try {
    return await getLatestReleaseFromWeb(ownerRepo, { timeoutMs, fetchImpl, webBaseUrl });
  } catch (webError) {
    try {
      return await getLatestReleaseFromApi(ownerRepo, { timeoutMs, env, fetchImpl, apiBaseUrl });
    } catch (apiError) {
      if (apiError && apiError.status === 403) throw webError;
      throw apiError;
    }
  }
}

function run(file, args, options = {}) {
  return execFileSync(file, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
    ...options
  });
}

export async function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });

  if (process.platform === 'win32') {
    // Paths travel through environment variables so no shell quoting is involved.
    run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -LiteralPath $env:AGY_AIO_ZIP -DestinationPath $env:AGY_AIO_DEST -Force'
      ],
      { env: { ...process.env, AGY_AIO_ZIP: zipPath, AGY_AIO_DEST: destDir } }
    );
    return;
  }

  const attempts = [
    () => run('unzip', ['-o', '-q', zipPath, '-d', destDir]),
    () => run('tar', ['-xf', zipPath, '-C', destDir]),
    () => run('python3', ['-m', 'zipfile', '-e', zipPath, destDir])
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      attempt();
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Failed to extract ${zipPath}: ${lastError ? lastError.message : 'no extractor available'}`);
}

export async function extractTarGz(tarPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  run('tar', ['-xzf', tarPath, '-C', destDir]);
}
