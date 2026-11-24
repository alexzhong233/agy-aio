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

export async function fetchJson(url, { timeoutMs = 15000, headers = {}, env = process.env } = {}) {
  const response = await fetch(url, {
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

export async function getLatestRelease(ownerRepo, { timeoutMs = 15000, env = process.env } = {}) {
  const data = await fetchJson(`https://api.github.com/repos/${ownerRepo}/releases/latest`, {
    timeoutMs,
    env
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
    }))
  };
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
