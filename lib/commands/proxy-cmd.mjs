// `agy-aio proxy` subcommands: config, test, build, run.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { c, section, info, ok, warn, err as fail, table } from '../ui.mjs';
import { getPlatformInfo, detectInstallations, detectLocalProxyPort } from '../platform.mjs';
import {
  getConfigPath,
  loadConfig,
  saveConfig,
  updateProxyEndpoint,
  syncConfigToTarget
} from '../config.mjs';
import { buildPosixProxy, testProxyConnectivity, runWithProxy } from '../modules/proxy.mjs';

const DEFAULT_TEST_TARGETS = ['daily-cloudcode-pa.googleapis.com', 'oauth2.googleapis.com'];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const POSIX_PROXY_LIB_NAMES = ['libantigravity_proxy.dylib', 'libantigravity_proxy.so'];

function hasBuiltPosixProxy(platformInfo) {
  const home = platformInfo.dataDir || path.join(platformInfo.realUserHome || os.homedir(), '.agy-aio');
  const dirs = [path.join(REPO_ROOT, 'modules', 'proxy-posix'), path.join(home, 'bin')];
  return dirs.some(dir => POSIX_PROXY_LIB_NAMES.some(name => fs.existsSync(path.join(dir, name))));
}

export function proxyUsage() {
  console.log(`
${c.bold('agy-aio proxy')} <config|test|build|run> [options]

  ${c.cyan('config')}   查看或修改代理配置（可配合 --sync 同步到客户端）
  ${c.cyan('test')}     测试代理到 Google 服务的连通性
  ${c.cyan('build')}    构建 POSIX 版透明代理库/启动器
  ${c.cyan('run')}      通过代理运行任意命令

${c.bold('选项')}
  --host <host>         代理主机 (config/test)
  --port <port>         代理端口 (config/test)
  --type <type>         socks5 | http (config/test)
  --sync                将 config.json 强制同步到已检测到的安装目录
  --detect              自动探测本机正在监听的代理端口
  --no-universal        仅构建当前架构（macOS 默认 universal）
  --target-host <host>  test 的自定义目标主机（可重复语义：逗号分隔）
  --target-port <port>  test 的目标端口，默认 443
  --dry-run             预览操作，不写入文件

${c.bold('示例')}
  agy-aio proxy config --detect --sync
  agy-aio proxy test
  agy-aio proxy build
  agy-aio proxy run -- node -e "console.log(process.env.HTTPS_PROXY)"
`);
}

function proxyEndpointText(proxy) {
  const host = proxy.host || '127.0.0.1';
  const port = proxy.port != null ? proxy.port : '(unset)';
  const type = proxy.type || 'socks5';
  return `${type}://${host}:${port}`;
}

function collectSyncDirs(installations, platform) {
  const dirs = [];
  const seen = new Set();
  const push = dir => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    const key = platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return;
    seen.add(key);
    dirs.push(resolved);
  };

  const entries = [
    ...(installations.desktop || []).map(entry => ({ entry, kind: 'desktop' })),
    ...(installations.ide || []).map(entry => ({ entry, kind: 'ide' })),
    ...(installations.cli || []).map(entry => ({ entry, kind: 'cli' }))
  ];

  for (const { entry, kind } of entries) {
    if (kind === 'cli') {
      const binPath = entry.cliBinPath || entry.exePath;
      if (binPath) push(path.dirname(binPath));
      continue;
    }

    if (platform === 'win32') {
      if (entry.exePath) push(path.dirname(entry.exePath));
      else if (entry.resourcesDir) push(entry.resourcesDir);
      else if (entry.rootDir) push(entry.rootDir);
      continue;
    }

    for (const languageServer of entry.languageServers || []) {
      push(path.dirname(languageServer));
    }
  }

  return dirs;
}

async function runConfig(opts, platformInfo) {
  const configPath = getConfigPath(platformInfo);
  const { config, exists } = loadConfig(configPath);

  if (!exists) info(`配置文件尚不存在，将使用默认值: ${configPath}`);

  const endpoint = {};
  let detected = null;

  if (opts.detect) {
    section('自动探测本地代理');
    detected = await detectLocalProxyPort();
    if (detected) {
      endpoint.host = detected.host;
      endpoint.port = detected.port;
      endpoint.type = detected.type;
      ok(`检测到本地代理: ${proxyEndpointText(detected)}${detected.source ? c.dim(` (${detected.source})`) : ''}`);
    } else {
      warn('未能自动检测到本地代理端口，保留当前配置。');
    }
  }

  if (opts.proxyHost !== undefined) endpoint.host = opts.proxyHost;
  if (opts.proxyPort !== undefined) endpoint.port = opts.proxyPort;
  if (opts.proxyType !== undefined) endpoint.type = String(opts.proxyType).toLowerCase();

  let next = config;
  if (Object.keys(endpoint).length > 0) {
    next = updateProxyEndpoint(config, endpoint);
    if (opts.dryRun) {
      info(`[dry-run] 将更新代理配置: ${proxyEndpointText(next.proxy)}`);
    } else {
      saveConfig(next, configPath, platformInfo);
      ok(`已更新代理配置: ${proxyEndpointText(next.proxy)}`);
    }
  }

  if (opts.sync) {
    section('同步配置到客户端');
    const installations = detectInstallations({ appDir: opts.appDir, platformInfo });
    const dirs = collectSyncDirs(installations, platformInfo.os);

    if (dirs.length === 0) {
      warn('未检测到 Antigravity 安装目录，跳过同步。');
    } else if (opts.dryRun) {
      for (const dir of dirs) info(`[dry-run] 将写入 ${path.join(dir, 'config.json')}`);
    } else {
      let written = 0;
      for (const dir of dirs) {
        const result = syncConfigToTarget(dir, next, { force: true, platformInfo });
        if (result.written) {
          written += 1;
          ok(`已同步: ${result.path}`);
        } else {
          warn(`未写入: ${result.path}`);
        }
      }
      info(`共同步 ${written}/${dirs.length} 个目录。`);
    }
  }

  const proxy = next.proxy || {};
  const fakeIp = next.fake_ip || {};

  section('当前代理配置');
  table(
    [
      ['host', proxy.host || '127.0.0.1'],
      ['port', proxy.port != null ? String(proxy.port) : '(unset)'],
      ['type', proxy.type || 'socks5'],
      ['fake_ip', fakeIp.enabled === false ? 'disabled' : `${fakeIp.cidr || '198.18.0.0/15'} (enabled)`],
      ['config', configPath]
    ],
    ['字段', '值']
  );

  return { config: next, path: configPath, detected };
}

async function runTest(opts, platformInfo) {
  const configPath = getConfigPath(platformInfo);
  const { config } = loadConfig(configPath);

  const override = {};
  if (opts.proxyHost !== undefined) override.host = opts.proxyHost;
  if (opts.proxyPort !== undefined) override.port = opts.proxyPort;
  if (opts.proxyType !== undefined) override.type = String(opts.proxyType).toLowerCase();

  const effective = Object.keys(override).length > 0 ? updateProxyEndpoint(config, override) : config;
  const proxy = effective.proxy || {};

  const targets = opts.targetHost
    ? String(opts.targetHost)
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
    : DEFAULT_TEST_TARGETS;
  const targetPort = opts.targetPort || 443;

  section('代理连通性测试');
  info(`代理: ${proxyEndpointText(proxy)}`);
  info(`目标: ${targets.map(host => `${host}:${targetPort}`).join(', ')}`);
  if (targets.length === 0) {
    fail('没有可用的测试目标。');
    process.exitCode = 1;
    return { ok: false, results: [] };
  }

  const results = [];
  for (const host of targets) {
    const result = await testProxyConnectivity(effective, { targetHost: host, targetPort });
    results.push(result);
  }

  table(
    results.map(result => {
      const status = result.ok ? c.green('PASS') : c.red('FAIL');
      const detail = result.ok
        ? result.proxyType === 'http'
          ? 'HTTP CONNECT 成功'
          : 'SOCKS5 握手成功'
        : result.error || '连接失败';
      return [result.targetHost, status, `${result.latencyMs} ms`, detail];
    }),
    ['目标', '结果', '延迟', '说明']
  );

  const failures = results.filter(result => !result.ok);
  if (failures.length === 0) {
    ok(`全部 ${results.length} 个目标连接成功。`);
  } else {
    fail(`${failures.length}/${results.length} 个目标连接失败。`);
    warn('请确认本地代理已启动，且 host/port/type 与客户端设置一致。');
    process.exitCode = 1;
  }

  return { ok: failures.length === 0, results };
}

function runBuild(opts) {
  section('构建 POSIX 代理');
  if (opts.noUniversal) info('构建模式: 当前架构');
  else info('构建模式: universal（macOS 上同时包含 arm64/x86_64）');

  const result = buildPosixProxy({
    universal: !opts.noUniversal,
    dryRun: Boolean(opts.dryRun)
  });

  if (result.skipped) {
    warn(`当前平台无需构建 POSIX 代理 (${result.reason || 'not-posix'})。`);
    return result;
  }

  if (result.dryRun) {
    info(`[dry-run] 将构建目标: ${result.target || 'default'}`);
    return result;
  }

  ok('构建完成。');
  table(
    [
      ['lib', result.libPath || '(unknown)'],
      ['launcher', result.launcherPath || '(unknown)']
    ],
    ['产物', '路径']
  );
  return result;
}

function runCommand(args, opts, platformInfo) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error('用法: agy-aio proxy run -- <命令> [参数...]（缺少要执行的命令）');
  }

  const configPath = getConfigPath(platformInfo);
  const { config } = loadConfig(configPath);

  section('通过代理运行命令');
  info(`命令: ${args.join(' ')}`);
  info(`代理: ${proxyEndpointText((config && config.proxy) || {})}`);

  if ((platformInfo.os === 'darwin' || platformInfo.os === 'linux') && !hasBuiltPosixProxy(platformInfo)) {
    info('未检测到已编译的代理库，正在自动构建…');
    buildPosixProxy({ universal: !opts.noUniversal });
  }

  const result = runWithProxy(args, config);
  process.exitCode = result.status ?? 1;
  return result;
}

export async function runProxyCmd(subcommand, args = [], opts = {}) {
  const platformInfo = getPlatformInfo();
  const command = String(subcommand || '').trim();

  if (!command) {
    proxyUsage();
    return;
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    proxyUsage();
    return;
  }

  switch (command) {
    case 'config':
      return runConfig(opts, platformInfo);
    case 'test':
      return runTest(opts, platformInfo);
    case 'build':
      return runBuild(opts);
    case 'run':
      return runCommand(args, opts, platformInfo);
    default:
      fail(`未知的 proxy 子命令: ${command}`);
      proxyUsage();
      process.exitCode = 1;
      return undefined;
  }
}
