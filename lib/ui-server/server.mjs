// agy-aio 本机 Web 控制面板服务端。纯 Node.js ESM，零 npm 依赖。
// 仅绑定 127.0.0.1，所有写操作都要求同源回环请求 + CSRF 安全令牌。

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { getPlatformInfo, detectInstallations, isAntigravityRunning, detectLocalProxyPort } from '../platform.mjs';
import {
  getConfigPath,
  getDefaultConfig,
  loadConfig,
  saveConfig,
  updateProxyEndpoint,
  syncConfigToTarget
} from '../config.mjs';
import { getLatestRelease } from '../net.mjs';
import { launchAntigravity } from '../launcher.mjs';
import { getCapsuleStatus } from '../modules/capsule.mjs';
import {
  getLocalizationStatus,
  evaluateLocalizationCompatibility,
  UPSTREAM_REPO as L10N_REPO
} from '../modules/localization.mjs';
import { getProxyStatus, testProxyConnectivity } from '../modules/proxy.mjs';
import { runInstall } from '../commands/install.mjs';
import { runRestore } from '../commands/restore.mjs';
import { runUninstall } from '../commands/uninstall.mjs';

const require = createRequire(import.meta.url);
const {
  isValidLoopbackHostHeader,
  readJsonBody,
  createAsyncWriteLock,
  httpError
} = require('../../modules/localization/src/http-security.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(HERE, 'index.html');

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const BIND_HOST = '127.0.0.1';
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const MAX_JSON_BYTES = 65536;

const CAPSULE_REPO = 'Lumidarin/agy-capsule';
const PROXY_REPO = 'yuaotian/antigravity-proxy';

const PROXY_TEST_TARGETS = ['daily-cloudcode-pa.googleapis.com', 'oauth2.googleapis.com'];

/* ------------------------------------------------------------------ *
 * 安全校验
 * ------------------------------------------------------------------ */

function tokensEqual(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function verifyLoopbackRequest(req, { csrfToken, expectedPort, requireToken = false } = {}) {
  const headers = (req && req.headers) || {};

  if (!isValidLoopbackHostHeader(headers.host, expectedPort)) {
    throw httpError('拒绝非本机回环 Host 请求', 403);
  }

  if (headers.origin !== undefined) {
    let sameOrigin = false;
    try {
      const own = new URL(`http://${String(headers.host).trim()}`);
      const supplied = new URL(String(headers.origin));
      sameOrigin =
        LOOPBACK_HOSTNAMES.has(own.hostname.toLowerCase()) &&
        LOOPBACK_HOSTNAMES.has(supplied.hostname.toLowerCase()) &&
        supplied.origin === own.origin;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) throw httpError('拒绝跨源请求', 403);
  }

  if (headers['sec-fetch-site'] && String(headers['sec-fetch-site']).toLowerCase() === 'cross-site') {
    throw httpError('拒绝跨站请求', 403);
  }

  if (requireToken && !tokensEqual(headers['x-agy-aio-token'], csrfToken)) {
    throw httpError('安全令牌缺失或校验失败', 403);
  }
}

/* ------------------------------------------------------------------ *
 * 通用工具
 * ------------------------------------------------------------------ */

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toStringArray(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  return list
    .map(item => String(item).trim())
    .filter(Boolean);
}

function toIntegerArray(value, label) {
  const list = Array.isArray(value) ? value : toStringArray(value);
  const numbers = list.map(item => Number(item));
  if (numbers.some(n => !Number.isInteger(n) || n < 1 || n > 65535)) {
    throw httpError(`${label} 必须是 1-65535 的整数集合`, 400);
  }
  return numbers;
}

const CDP_MODES = new Set(['native', 'wrapper', 'none']);

// 只把已知的 CDP 模式透传给 runInstall / runRestore，避免任意字符串进入安装流程。
function normalizeCdpMode(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const mode = String(value);
  if (!CDP_MODES.has(mode)) {
    throw httpError('cdpMode 必须是 native、wrapper 或 none', 400);
  }
  return mode;
}

function safeSync(fn, fallback = {}) {
  try {
    return fn();
  } catch (error) {
    return { ...fallback, error: error && error.message ? error.message : String(error) };
  }
}

async function safeAsync(fn, fallback = {}) {
  try {
    return await fn();
  } catch (error) {
    return { ...fallback, error: error && error.message ? error.message : String(error) };
  }
}

function loadConfigSafe(configPath) {
  try {
    const loaded = loadConfig(configPath);
    return { config: loaded.config, exists: loaded.exists, path: loaded.path };
  } catch (error) {
    return {
      config: getDefaultConfig(),
      exists: false,
      path: configPath,
      error: error && error.message ? error.message : String(error)
    };
  }
}

function formatLogArg(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

// 在写锁内临时接管 console.log：既照常打印到终端，又把去除 ANSI 的日志返回给前端。
export async function captureConsoleLogs(fn) {
  const logs = [];
  const original = console.log;
  console.log = (...args) => {
    const line = args.map(formatLogArg).join(' ');
    logs.push(line.replace(ANSI_PATTERN, ''));
    original.apply(console, args);
  };

  try {
    const result = await fn();
    return { result, logs };
  } catch (error) {
    if (error && typeof error === 'object') error.logs = logs;
    throw error;
  } finally {
    console.log = original;
  }
}

// 保存配置后需要同步 config.json 的目录：桌面端 / IDE 的二进制目录与 CLI 所在目录，
// 这些位置都是 Antigravity 实际读取 config.json 的地方。
export function collectSyncDirs(installations, os) {
  const dirs = new Set();
  const add = dirPath => {
    if (!dirPath || typeof dirPath !== 'string') return;
    if (/\.orig$/i.test(dirPath)) return;
    dirs.add(path.resolve(dirPath));
  };

  const entries = isPlainObject(installations) ? installations : {};
  const desktop = Array.isArray(entries.desktop) ? entries.desktop : [];
  const ide = Array.isArray(entries.ide) ? entries.ide : [];
  const cli = Array.isArray(entries.cli) ? entries.cli : [];

  if (os === 'win32') {
    for (const entry of [...desktop, ...ide]) {
      if (!entry) continue;
      add(entry.exePath ? path.dirname(entry.exePath) : entry.resourcesDir || entry.rootDir);
    }
    for (const entry of cli) {
      const bin = entry && (entry.cliBinPath || entry.exePath);
      if (bin) add(path.dirname(bin));
    }
    return [...dirs];
  }

  for (const entry of [...desktop, ...ide]) {
    if (!entry) continue;
    for (const bin of Array.isArray(entry.languageServers) ? entry.languageServers : []) {
      add(path.dirname(bin));
    }
  }
  for (const entry of cli) {
    const bin = entry && (entry.cliBinPath || entry.exePath);
    if (bin) add(path.dirname(bin));
  }
  return [...dirs];
}

function syncConfigEverywhere(installations, os, config, platformInfo) {
  const syncedDirs = [];
  const syncErrors = [];

  for (const dir of collectSyncDirs(installations, os)) {
    try {
      syncConfigToTarget(dir, config, { force: true, platformInfo });
      syncedDirs.push(dir);
    } catch (error) {
      syncErrors.push({ dir, error: error && error.message ? error.message : String(error) });
    }
  }

  return { syncedDirs, syncErrors };
}

/* ------------------------------------------------------------------ *
 * 配置校验
 * ------------------------------------------------------------------ */

function sanitizeRule(rule, index) {
  if (!isPlainObject(rule)) {
    throw httpError(`第 ${index + 1} 条分流规则必须是对象`, 400);
  }
  if (rule.action !== 'direct' && rule.action !== 'proxy') {
    throw httpError(`第 ${index + 1} 条分流规则的 action 必须是 direct 或 proxy`, 400);
  }

  const next = { ...rule };
  next.enabled = rule.enabled !== false;
  next.action = rule.action;
  next.name =
    typeof rule.name === 'string' && rule.name.trim() ? rule.name.trim() : `规则 ${index + 1}`;
  next.domains = toStringArray(rule.domains);
  if (rule.ip_cidrs_v4 !== undefined) next.ip_cidrs_v4 = toStringArray(rule.ip_cidrs_v4);
  return next;
}

function applyProxyRules(config, input) {
  if (!isPlainObject(input)) throw httpError('proxy_rules 必须是对象', 400);

  const baseRules = isPlainObject(config.proxy_rules) ? config.proxy_rules : {};
  const merged = { ...baseRules, ...input };

  if (merged.routing !== undefined) {
    if (!isPlainObject(merged.routing)) throw httpError('proxy_rules.routing 必须是对象', 400);
    const baseRouting = isPlainObject(baseRules.routing) ? baseRules.routing : {};
    const routing = { ...baseRouting, ...merged.routing };

    if (routing.rules !== undefined) {
      if (!Array.isArray(routing.rules)) {
        throw httpError('proxy_rules.routing.rules 必须是数组', 400);
      }
      routing.rules = routing.rules.map((rule, index) => sanitizeRule(rule, index));
    }
    if (routing.default_action !== undefined) {
      if (routing.default_action !== 'direct' && routing.default_action !== 'proxy') {
        throw httpError("proxy_rules.routing.default_action 必须是 'direct' 或 'proxy'", 400);
      }
    }
    merged.routing = routing;
  }

  if (merged.allowed_ports !== undefined) {
    merged.allowed_ports = toIntegerArray(merged.allowed_ports, 'proxy_rules.allowed_ports');
  }

  return merged;
}

function applyFakeIp(config, input) {
  if (!isPlainObject(input)) throw httpError('fake_ip 必须是对象', 400);
  const patch = {};
  if (input.enabled !== undefined) patch.enabled = Boolean(input.enabled);
  if (input.cidr !== undefined) {
    if (typeof input.cidr !== 'string' || !input.cidr.trim()) {
      throw httpError('fake_ip.cidr 必须是非空字符串', 400);
    }
    patch.cidr = input.cidr.trim();
  }
  return { ...(isPlainObject(config.fake_ip) ? config.fake_ip : {}), ...patch };
}

function applyTimeout(config, input) {
  if (!isPlainObject(input)) throw httpError('timeout 必须是对象', 400);
  const patch = {};
  for (const key of ['connect_ms', 'send_ms', 'recv_ms']) {
    if (input[key] === undefined) continue;
    const value = Number(input[key]);
    if (!Number.isInteger(value) || value < 1 || value > 600000) {
      throw httpError(`timeout.${key} 必须是 1-600000 的整数`, 400);
    }
    patch[key] = value;
  }
  return { ...(isPlainObject(config.timeout) ? config.timeout : {}), ...patch };
}

/* ------------------------------------------------------------------ *
 * 状态采集
 * ------------------------------------------------------------------ */

async function buildStatus({ appDir, pluginsDir, env }) {
  const platformInfo = getPlatformInfo({ env });
  const installations = detectInstallations({ appDir, platformInfo, env });
  const configPath = getConfigPath(platformInfo);
  const configResult = loadConfigSafe(configPath);
  const running = isAntigravityRunning();

  const capsule = safeSync(() => getCapsuleStatus({ pluginsDir, platformInfo, installations, env }));
  const localization = safeSync(() =>
    getLocalizationStatus({ appDir, platformInfo, installations, env })
  );
  const proxy = await safeAsync(() =>
    getProxyStatus({
      appDir,
      config: configResult.config,
      platformInfo,
      installations,
      env
    })
  );

  const status = {
    platform: platformInfo,
    node: process.version,
    running,
    installations,
    capsule,
    localization,
    proxy,
    config: configResult.config,
    configPath,
    configExists: configResult.exists
  };
  if (configResult.error) status.configError = configResult.error;
  return status;
}

function normalizeTag(tag) {
  return String(tag == null ? '' : tag)
    .trim()
    .replace(/^v/i, '');
}

/* ------------------------------------------------------------------ *
 * HTTP 助手
 * ------------------------------------------------------------------ */

function sendJson(res, statusCode, payload, headOnly = false) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(headOnly ? undefined : body);
}

function sendHtml(res, html, headOnly = false) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  });
  res.end(headOnly ? undefined : body);
}

/* ------------------------------------------------------------------ *
 * 服务启动
 * ------------------------------------------------------------------ */

export async function startUiServer({
  port = 3399,
  strictPort = false,
  host = BIND_HOST,
  appDir = '',
  pluginsDir,
  env = process.env
} = {}) {
  if (host !== BIND_HOST && host !== 'localhost') {
    throw new Error(`控制面板只允许绑定本机回环地址（收到 host=${host}）。`);
  }

  const csrfToken = crypto.randomBytes(32).toString('hex');
  const writeLock = createAsyncWriteLock();
  const platformInfo = getPlatformInfo({ env });

  let server = null;
  let boundPort = 0;

  const currentPort = () => {
    if (boundPort) return boundPort;
    const address = server && server.address();
    return address && typeof address === 'object' ? address.port : 0;
  };

  const detectInstalls = () => detectInstallations({ appDir, platformInfo, env });

  async function executeAction(owner, task) {
    const previousExitCode = process.exitCode;
    try {
      return await writeLock.tryRun(() => captureConsoleLogs(task), {
        owner,
        conflictMessage: '已有安装、恢复或卸载操作正在进行，请稍后再试'
      });
    } finally {
      process.exitCode = previousExitCode;
    }
  }

  function renderHtml() {
    const template = fs.readFileSync(HTML_PATH, 'utf8');
    return template.split('{{CSRF_TOKEN}}').join(csrfToken);
  }

  async function handleRequest(req, res) {
    const method = req.method || 'GET';
    const rawUrl = req.url || '/';

    if (!rawUrl.startsWith('/')) throw httpError('无效的请求路径', 400);

    const isRead = method === 'GET' || method === 'HEAD';
    verifyLoopbackRequest(req, {
      csrfToken,
      expectedPort: currentPort(),
      requireToken: !isRead
    });

    const pathname = rawUrl.split('?')[0];

    if (isRead) {
      if (pathname === '/') {
        sendHtml(res, renderHtml(), method === 'HEAD');
        return;
      }
      if (pathname === '/favicon.ico') {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      if (pathname === '/api/status') {
        const status = await buildStatus({ appDir, pluginsDir, env });
        sendJson(res, 200, status, method === 'HEAD');
        return;
      }
      if (pathname === '/api/proxy/config') {
        const configPath = getConfigPath(platformInfo);
        const result = loadConfigSafe(configPath);
        const payload = { config: result.config, exists: result.exists, path: configPath };
        if (result.error) payload.error = result.error;
        sendJson(res, 200, payload, method === 'HEAD');
        return;
      }
      if (pathname.startsWith('/api/')) {
        throw httpError('接口不存在', 404);
      }
      throw httpError('页面不存在', 404);
    }

    if (method !== 'POST') {
      throw httpError('不支持的请求方法', 405);
    }

    if (pathname === '/api/proxy/config') {
      const body = await readJsonBody(req, { maxBytes: MAX_JSON_BYTES, allowEmpty: false });
      const configPath = getConfigPath(platformInfo);
      let config = loadConfigSafe(configPath).config;

      if (body.proxy !== undefined) {
        if (!isPlainObject(body.proxy)) throw httpError('proxy 必须是对象', 400);
        try {
          config = updateProxyEndpoint(config, body.proxy);
        } catch (error) {
          throw httpError(`代理配置无效：${error.message}`, 400);
        }
      }
      if (body.fake_ip !== undefined) config = { ...config, fake_ip: applyFakeIp(config, body.fake_ip) };
      if (body.timeout !== undefined) config = { ...config, timeout: applyTimeout(config, body.timeout) };
      if (body.child_injection !== undefined) config = { ...config, child_injection: Boolean(body.child_injection) };
      if (body.target_processes !== undefined) {
        const list = toStringArray(body.target_processes);
        if (list.length === 0) throw httpError('target_processes 不能为空', 400);
        config = { ...config, target_processes: list };
      }
      if (body.proxy_rules !== undefined) {
        config = { ...config, proxy_rules: applyProxyRules(config, body.proxy_rules) };
      }

      saveConfig(config, configPath, platformInfo);

      let syncedDirs = [];
      let syncErrors = [];
      if (body.sync !== false) {
        const installations = detectInstalls();
        ({ syncedDirs, syncErrors } = syncConfigEverywhere(
          installations,
          platformInfo.os,
          config,
          platformInfo
        ));
      }

      const payload = { ok: true, config, path: configPath, syncedDirs };
      if (syncErrors.length > 0) payload.syncErrors = syncErrors;
      sendJson(res, 200, payload);
      return;
    }

    if (pathname === '/api/proxy/detect') {
      await readJsonBody(req, { maxBytes: MAX_JSON_BYTES, allowEmpty: true });
      const detected = await detectLocalProxyPort({ env });
      sendJson(res, 200, { ok: true, found: Boolean(detected), detected });
      return;
    }

    if (pathname === '/api/proxy/test') {
      const body = await readJsonBody(req, { maxBytes: MAX_JSON_BYTES, allowEmpty: true });
      const configPath = getConfigPath(platformInfo);
      let config = loadConfigSafe(configPath).config;

      if (body.host !== undefined || body.port !== undefined || body.type !== undefined) {
        try {
          config = updateProxyEndpoint(config, { host: body.host, port: body.port, type: body.type });
        } catch (error) {
          throw httpError(`代理配置无效：${error.message}`, 400);
        }
      }

      const results = await Promise.all(
        PROXY_TEST_TARGETS.map(targetHost =>
          testProxyConnectivity(config, { targetHost, targetPort: 443 })
        )
      );
      const allPassed = results.length > 0 && results.every(result => result.ok);
      sendJson(res, 200, { ok: allPassed, results });
      return;
    }

    if (pathname === '/api/updates/check') {
      await readJsonBody(req, { maxBytes: MAX_JSON_BYTES, allowEmpty: true });
      const repos = [
        ['capsule', CAPSULE_REPO],
        ['localization', L10N_REPO],
        ['proxy', PROXY_REPO]
      ];

      const settled = await Promise.allSettled(
        repos.map(([, repo]) => getLatestRelease(repo, { env }))
      );

      const updates = {};
      settled.forEach((outcome, index) => {
        const [key, repo] = repos[index];
        if (outcome.status === 'fulfilled' && outcome.value && outcome.value.tag) {
          updates[key] = {
            repo,
            tag: outcome.value.tag,
            name: outcome.value.name || outcome.value.tag,
            error: null
          };
        } else {
          const reason = outcome.status === 'rejected' ? outcome.reason : new Error('未返回 release 信息');
          updates[key] = {
            repo,
            tag: null,
            name: null,
            error: reason && reason.message ? reason.message.split('\n')[0] : String(reason)
          };
        }
      });

      const localization = safeSync(() =>
        getLocalizationStatus({ appDir, platformInfo, installations: detectInstalls(), env })
      );
      const clientVersion = localization.clientVersion || null;
      const upstreamTag = updates.localization && updates.localization.tag;

      if (clientVersion && upstreamTag) {
        const normalized = normalizeTag(upstreamTag);
        const compat = evaluateLocalizationCompatibility({ clientVersion, patchVersion: normalized });
        updates.localization.normalizedTag = normalized;
        updates.localization.match = compat.status;
        updates.localization.compatible = compat.compatible;
        updates.localization.message = compat.message;
      }

      sendJson(res, 200, {
        ok: true,
        updates,
        clientVersion
      });
      return;
    }

    if (pathname === '/api/actions/install') {
      const body = await readJsonBody(req, { maxBytes: MAX_JSON_BYTES, allowEmpty: true });
      const cdpMode = normalizeCdpMode(body.cdpMode);
      const { result, logs } = await executeAction('install', () =>
        runInstall({
          ...body,
          // 显式覆盖为已校验的值，保证 cdpMode 只可能是 native / wrapper / none。
          ...(cdpMode ? { cdpMode } : {}),
          yes: true,
          appDir: body.appDir ?? appDir,
          pluginsDir: body.pluginsDir ?? pluginsDir,
          env
        })
      );
      sendJson(res, 200, { ok: result ? result.ok !== false : true, result, logs });
      return;
    }

    if (pathname === '/api/actions/restore') {
      const body = await readJsonBody(req, { maxBytes: MAX_JSON_BYTES, allowEmpty: true });
      const cdpMode = normalizeCdpMode(body.cdpMode);
      const { result, logs } = await executeAction('restore', () =>
        runRestore({
          ...body,
          ...(cdpMode ? { cdpMode } : {}),
          yes: true,
          appDir: body.appDir ?? appDir,
          pluginsDir: body.pluginsDir ?? pluginsDir,
          env
        })
      );
      sendJson(res, 200, { ok: result ? result.ok !== false : true, result, logs });
      return;
    }

    if (pathname === '/api/actions/uninstall') {
      const body = await readJsonBody(req, { maxBytes: MAX_JSON_BYTES, allowEmpty: true });
      const { result, logs } = await executeAction('uninstall', () =>
        runUninstall({
          ...body,
          // 只有布尔 true 才移除 CDP 入口，避免字符串 "false" 被当成真值。
          undoCdp: Boolean(body.undoCdp),
          yes: true,
          appDir: body.appDir ?? appDir,
          pluginsDir: body.pluginsDir ?? pluginsDir,
          env
        })
      );
      sendJson(res, 200, { ok: result ? result.ok !== false : true, result, logs });
      return;
    }

    if (pathname === '/api/actions/launch') {
      const body = await readJsonBody(req, { maxBytes: MAX_JSON_BYTES, allowEmpty: true });
      const installations = detectInstalls();
      const result = launchAntigravity({
        dryRun: Boolean(body.dryRun),
        platformInfo,
        installations
      });
      const ok =
        Boolean(result) &&
        result.supported !== false &&
        (result.launched === true || result.dryRun === true || result.configured === true);
      sendJson(res, 200, { ok, result });
      return;
    }

    if (pathname === '/api/shutdown') {
      await readJsonBody(req, { maxBytes: MAX_JSON_BYTES, allowEmpty: true });
      sendJson(res, 200, { ok: true });
      setTimeout(() => {
        try {
          if (server) {
            server.close();
            if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
          }
        } catch {
          // 关闭阶段的异常无需再反馈给调用方。
        }
      }, 50);
      return;
    }

    throw httpError('接口不存在', 404);
  }

  const createServerFor = candidatePort =>
    http.createServer((req, res) => {
      handleRequest(req, res).catch(error => {
        const statusCode =
          error && Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
            ? error.statusCode
            : 500;
        if (res.headersSent) {
          try {
            res.destroy();
          } catch {
            // 连接可能已经关闭。
          }
          return;
        }
        const payload = {
          ok: false,
          error: error && error.message ? String(error.message) : '服务器内部错误'
        };
        if (error && Array.isArray(error.logs)) payload.logs = error.logs;
        try {
          sendJson(res, statusCode, payload);
        } catch {
          try {
            res.destroy();
          } catch {
            // 客户端可能已经断开，无需继续处理。
          }
        }
      });
    });

  let candidatePort = port;

  for (;;) {
    const attempt = createServerFor(candidatePort);
    try {
      await new Promise((resolve, reject) => {
        const onError = error => {
          attempt.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          attempt.removeListener('error', onError);
          resolve();
        };
        attempt.once('error', onError);
        attempt.once('listening', onListening);
        attempt.listen(candidatePort, BIND_HOST);
      });
      server = attempt;
      break;
    } catch (error) {
      try {
        attempt.on('error', () => {});
        attempt.close();
      } catch {
        // 端口未监听时无需清理。
      }
      const canRetry =
        error &&
        error.code === 'EADDRINUSE' &&
        port !== 0 &&
        !strictPort &&
        candidatePort < port + 10;
      if (canRetry) {
        candidatePort += 1;
        continue;
      }
      throw new Error(
        `无法在 ${BIND_HOST}:${candidatePort} 启动控制面板：${
          error && error.message ? error.message : String(error)
        }`
      );
    }
  }

  const address = server.address();
  boundPort = address && typeof address === 'object' ? address.port : candidatePort;

  server.on('error', error => {
    console.error(`[agy-aio] 控制面板服务器错误：${error && error.message ? error.message : error}`);
  });

  const close = () =>
    new Promise(resolve => {
      if (!server || !server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    });

  return {
    server,
    host: BIND_HOST,
    port: boundPort,
    url: `http://${BIND_HOST}:${boundPort}`,
    csrfToken,
    close
  };
}
