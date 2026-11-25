#!/usr/bin/env node
// agy-aio CLI entrypoint — zero dependencies, Node.js >= 18.18.0.

import { readFileSync } from 'node:fs';

import { c, banner, err as printError } from '../lib/ui.mjs';

function readVersion() {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    );
    return typeof manifest.version === 'string' && manifest.version.trim()
      ? manifest.version.trim()
      : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const VERSION = readVersion();

/* ------------------------------------------------------------------ *
 * Option schema
 * ------------------------------------------------------------------ */

const GLOBAL_OPTIONS = {
  '-h': { key: 'help', kind: 'boolean' },
  '--help': { key: 'help', kind: 'boolean' },
  '-v': { key: 'version', kind: 'boolean' },
  '--version': { key: 'version', kind: 'boolean' },
  '-y': { key: 'yes', kind: 'boolean' },
  '--yes': { key: 'yes', kind: 'boolean' },
  '--dry-run': { key: 'dryRun', kind: 'boolean' },
  '--json': { key: 'json', kind: 'boolean' },
  '--app-dir': { key: 'appDir', kind: 'path' },
  '--plugins-dir': { key: 'pluginsDir', kind: 'path' }
};

const MAINTAIN_OPTIONS = {
  '--only': { key: 'only', kind: 'list' },
  '--layers': { key: 'only', kind: 'list' },
  '--skip': { key: 'skip', kind: 'list' },
  '--proxy-host': { key: 'proxyHost', kind: 'string' },
  '--proxy-port': { key: 'proxyPort', kind: 'port' },
  '--proxy-type': { key: 'proxyType', kind: 'enum', values: ['socks5', 'http'] },
  '--l10n-mode': { key: 'l10nMode', kind: 'enum', values: ['auto', 'online', 'local'] },
  '--cdp-mode': { key: 'cdpMode', kind: 'enum', values: ['native', 'wrapper', 'none'] },
  '--no-cdp': { key: 'noCdp', kind: 'boolean' },
  '--undo-cdp': { key: 'undoCdp', kind: 'boolean' },
  '--force-config': { key: 'forceConfig', kind: 'boolean' },
  '--rebuild': { key: 'rebuild', kind: 'boolean' },
  '--allow-version-mismatch': { key: 'allowVersionMismatch', kind: 'boolean' }
};

const PROXY_OPTIONS = {
  '--host': { key: 'proxyHost', kind: 'string' },
  '--port': { key: 'proxyPort', kind: 'port' },
  '--type': { key: 'proxyType', kind: 'enum', values: ['socks5', 'http'] },
  '--sync': { key: 'sync', kind: 'boolean' },
  '--detect': { key: 'detect', kind: 'boolean' },
  '--no-universal': { key: 'noUniversal', kind: 'boolean' },
  '--target-host': { key: 'targetHost', kind: 'string' },
  '--target-port': { key: 'targetPort', kind: 'port' }
};

const UPDATE_OPTIONS = {
  '--apply': { key: 'apply', kind: 'boolean' }
};

const UPGRADE_OPTIONS = {
  '--check': { key: 'check', kind: 'boolean' },
  '--no-restore': { key: 'noRestore', kind: 'boolean' },
  '--force': { key: 'force', kind: 'boolean' },
  '--package': { key: 'packagePath', kind: 'path' },
  '--l10n-mode': { key: 'l10nMode', kind: 'enum', values: ['auto', 'online', 'local'] },
  '--cdp-mode': { key: 'cdpMode', kind: 'enum', values: ['native', 'wrapper', 'none'] },
  '--no-cdp': { key: 'noCdp', kind: 'boolean' },
  '--allow-version-mismatch': { key: 'allowVersionMismatch', kind: 'boolean' }
};

const UI_OPTIONS = {
  '--port': { key: 'port', kind: 'port' },
  '--no-open': { key: 'noOpen', kind: 'boolean' }
};

const COMMANDS = new Set([
  'status',
  'doctor',
  'install',
  'uninstall',
  'restore',
  'proxy',
  'launch',
  'update',
  'upgrade',
  'ui',
  'help'
]);

/* ------------------------------------------------------------------ *
 * Argument parsing
 * ------------------------------------------------------------------ */

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

function splitToken(token) {
  if (token.startsWith('--')) {
    const eq = token.indexOf('=');
    if (eq > 2) return { name: token.slice(0, eq), inline: token.slice(eq + 1) };
  }
  return { name: token, inline: undefined };
}

function convertValue(flag, def, raw) {
  const value = raw == null ? '' : String(raw).trim();
  if (value === '') throw new UsageError(`选项 ${flag} 需要一个值。`);

  switch (def.kind) {
    case 'port': {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new UsageError(`选项 ${flag} 的端口无效: ${value}（应为 1-65535 的整数）`);
      }
      return port;
    }
    case 'list': {
      const items = value
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
      if (items.length === 0) throw new UsageError(`选项 ${flag} 至少需要一个值。`);
      return items;
    }
    case 'enum': {
      const normalized = value.toLowerCase();
      if (!def.values.includes(normalized)) {
        throw new UsageError(
          `选项 ${flag} 的值无效: ${value}（可选: ${def.values.join(', ')}）`
        );
      }
      return normalized;
    }
    case 'path':
    case 'string':
    default:
      return value;
  }
}

function readOption(tokens, index, spec) {
  const token = tokens[index];
  const { name, inline } = splitToken(token);
  const def = spec[name];

  if (!def) throw new UsageError(`未知选项: ${name}`);
  if (def.kind === 'boolean') {
    if (inline !== undefined) throw new UsageError(`选项 ${name} 不接受值。`);
    return { flag: name, def, value: true, nextIndex: index + 1 };
  }

  let raw = inline;
  if (raw === undefined) {
    const next = tokens[index + 1];
    if (next === undefined || next.startsWith('-')) {
      throw new UsageError(`选项 ${name} 需要一个值。`);
    }
    raw = next;
    return {
      flag: name,
      def,
      value: convertValue(name, def, raw),
      nextIndex: index + 2
    };
  }

  return { flag: name, def, value: convertValue(name, def, raw), nextIndex: index + 1 };
}

function assignOption(target, parsed) {
  target[parsed.def.key] = parsed.value;
}

function parseOptions(tokens, spec, { allowPositional = false } = {}) {
  const opts = {};
  const positional = [];

  for (let index = 0; index < tokens.length; ) {
    const token = tokens[index];

    if (token === '--') {
      positional.push(...tokens.slice(index + 1));
      break;
    }

    if (!token.startsWith('-') || token === '-') {
      positional.push(token);
      index += 1;
      continue;
    }

    const parsed = readOption(tokens, index, spec);
    assignOption(opts, parsed);
    index = parsed.nextIndex;
  }

  if (!allowPositional && positional.length > 0) {
    throw new UsageError(`无法识别的参数: ${positional.join(' ')}`);
  }

  return { opts, positional };
}

/* ------------------------------------------------------------------ *
 * Help output
 * ------------------------------------------------------------------ */

function printVersion() {
  console.log(VERSION);
}

function printHelp() {
  banner('agy-aio', `v${VERSION} · Antigravity 一站式工具`);
  console.log(`
${c.bold('用法')}
  agy-aio <command> [options]

${c.bold('命令')}
  ${c.cyan('status')}      查看安装与运行状态（${c.dim('doctor 为别名')}）
  ${c.cyan('install')}     安装胶囊插件、本地化与代理
  ${c.cyan('uninstall')}   卸载已安装的组件
  ${c.cyan('restore')}     恢复官方文件并重新应用补丁
  ${c.cyan('proxy')}       查看/修改代理配置、测试连通性、构建或代理运行命令
  ${c.cyan('launch')}      以 CDP 调试模式启动 Antigravity
  ${c.cyan('update')}      检查上游更新并按需应用
  ${c.cyan('upgrade')}     升级官方 Antigravity 客户端并自动恢复已启用补丁
  ${c.cyan('ui')}          启动本地 Web 控制面板（修改代理端口、分流规则与一键维护）
  ${c.cyan('help')}        显示本帮助

${c.bold('通用选项')}
  -h, --help              显示帮助
  -v, --version           显示版本
  -y, --yes               跳过确认
  --dry-run               预览操作，不写入文件
  --json                  以 JSON 输出（由具体命令支持）
  --app-dir <path>        指定 Antigravity 安装目录
  --plugins-dir <path>    指定胶囊插件目录

${c.bold('安装 / 卸载 / 恢复选项')}
  --only <list>           仅处理指定组件（逗号分隔）
  --layers <list>         指定处理层次（逗号分隔）
  --skip <list>           跳过指定组件（逗号分隔）
  --proxy-host <host>     代理主机
  --proxy-port <port>     代理端口
  --proxy-type <type>     socks5 | http
  --l10n-mode <mode>      auto | online | local
  --cdp-mode <mode>       native（免壳原版 App） | wrapper（独立图标） | none
  --no-cdp                不启用 CDP 启动器
  --undo-cdp              移除 CDP 启动器
  --force-config          强制覆盖目标 config.json
  --rebuild               强制重新构建代理
  --allow-version-mismatch 允许汉化包与客户端版本不匹配（仅在你确认兼容时使用）

${c.bold('proxy 选项')}
  --host <host>           代理主机
  --port <port>           代理端口
  --type <type>           socks5 | http
  --sync                  同步配置到已安装的 Antigravity 目录
  --detect                自动探测本地代理端口
  --no-universal          仅构建当前架构
  --target-host <host>    test 的目标主机
  --target-port <port>    test 的目标端口

${c.bold('update 选项')}
  --apply                 拉取并应用上游更新

${c.bold('upgrade 选项')}
  --check                 检查官方版本与待安装更新（不修改客户端）
  --no-restore            升级后不恢复汉化、代理与 CDP 补丁
  --force                 即使版本未变也强制替换客户端
  --package <path>        使用本地安装包升级
  --l10n-mode <mode>      auto | online | local
  --cdp-mode <mode>       native | wrapper | none
  --no-cdp                不恢复 CDP 启动器
  --allow-version-mismatch 允许汉化包与客户端版本不匹配（谨慎使用）

${c.bold('ui 选项')}
  --port <port>           本地 Web 面板端口（默认自动选择）
  --no-open               启动后不自动打开浏览器

${c.bold('示例')}
  agy-aio status
  agy-aio install --yes --proxy-port 7890
  agy-aio proxy config --detect --sync
  agy-aio proxy test
  agy-aio proxy run -- curl -sI https://www.google.com
  agy-aio ui
  agy-aio launch --dry-run
  agy-aio update --apply
  agy-aio upgrade --check
  agy-aio upgrade
`);
}

/* ------------------------------------------------------------------ *
 * Command dispatch
 * ------------------------------------------------------------------ */

async function loadHandler(file, exportName) {
  let mod;
  try {
    mod = await import(new URL(`../lib/commands/${file}`, import.meta.url));
  } catch (error) {
    if (error && error.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes(file)) {
      throw new Error(`命令模块缺失: lib/commands/${file}（请重新安装 agy-aio）`);
    }
    throw error;
  }

  const handler = mod[exportName];
  if (typeof handler !== 'function') {
    throw new Error(`命令模块 ${file} 未导出 ${exportName}()`);
  }
  return handler;
}

function commandOptions(command) {
  switch (command) {
    case 'install':
    case 'uninstall':
    case 'restore':
      return MAINTAIN_OPTIONS;
    case 'update':
      return UPDATE_OPTIONS;
    case 'upgrade':
      return UPGRADE_OPTIONS;
    case 'ui':
      return UI_OPTIONS;
    default:
      return {};
  }
}

async function handleProxy(rest, globalOpts) {
  const spec = { ...GLOBAL_OPTIONS, ...PROXY_OPTIONS };
  const opts = { ...globalOpts };
  let index = 0;

  while (index < rest.length && rest[index] !== '--' && rest[index].startsWith('-')) {
    const parsed = readOption(rest, index, spec);
    assignOption(opts, parsed);
    index = parsed.nextIndex;
  }

  if (opts.version) {
    printVersion();
    return;
  }

  const proxyModule = await import('../lib/commands/proxy-cmd.mjs');
  const token = rest[index];

  if (token === undefined) {
    proxyModule.proxyUsage();
    return;
  }

  if (token === '--') {
    await proxyModule.runProxyCmd('run', rest.slice(index + 1), opts);
    return;
  }

  const subcommand = token;
  const tail = rest.slice(index + 1);

  if (subcommand === 'help' || subcommand === '-h' || subcommand === '--help') {
    proxyModule.proxyUsage();
    return;
  }

  if (subcommand === 'run') {
    const args = tail[0] === '--' ? tail.slice(1) : tail;
    await proxyModule.runProxyCmd('run', args, opts);
    return;
  }

  if (subcommand !== 'config' && subcommand !== 'test' && subcommand !== 'build') {
    await proxyModule.runProxyCmd(subcommand, [], opts);
    return;
  }

  const { opts: tailOpts } = parseOptions(tail, spec, { allowPositional: false });
  const merged = { ...opts, ...tailOpts };

  if (merged.version) {
    printVersion();
    return;
  }
  if (merged.help) {
    proxyModule.proxyUsage();
    return;
  }

  await proxyModule.runProxyCmd(subcommand, [], merged);
}

async function dispatch(command, rest, globalOpts) {
  if (command === 'help') {
    printHelp();
    return;
  }

  if (command === 'proxy') {
    await handleProxy(rest, globalOpts);
    return;
  }

  const spec = { ...GLOBAL_OPTIONS, ...commandOptions(command) };
  const { opts } = parseOptions(rest, spec, { allowPositional: false });
  const merged = { ...globalOpts, ...opts };

  if (merged.version) {
    printVersion();
    return;
  }
  if (merged.help) {
    printHelp();
    return;
  }

  if (command === 'launch') {
    const { runLaunch } = await import('../lib/commands/launch.mjs');
    await runLaunch(merged);
    return;
  }

  if (command === 'update') {
    const { runUpdate } = await import('../lib/commands/update.mjs');
    await runUpdate(merged);
    return;
  }

  if (command === 'upgrade') {
    const runUpgrade = await loadHandler('upgrade.mjs', 'runUpgrade');
    await runUpgrade({ ...merged });
    return;
  }

  const handlers = {
    status: ['status.mjs', 'runStatus'],
    doctor: ['status.mjs', 'runStatus'],
    install: ['install.mjs', 'runInstall'],
    uninstall: ['uninstall.mjs', 'runUninstall'],
    restore: ['restore.mjs', 'runRestore'],
    ui: ['ui.mjs', 'runUi']
  };

  const entry = handlers[command];
  if (!entry) throw new UsageError(`未知命令: ${command}`);
  const handler = await loadHandler(entry[0], entry[1]);
  await handler(merged);
}

async function main(argv) {
  if (argv.length === 0) {
    printHelp();
    return;
  }

  const globalOpts = {};
  let index = 0;
  let command = null;

  while (index < argv.length) {
    const token = argv[index];

    if (token === '--') {
      const next = argv[index + 1];
      if (!next) throw new UsageError('缺少命令。');
      command = next;
      index += 2;
      break;
    }

    if (token.startsWith('-') && token !== '-') {
      const parsed = readOption(argv, index, GLOBAL_OPTIONS);
      assignOption(globalOpts, parsed);
      index = parsed.nextIndex;
      continue;
    }

    command = token;
    index += 1;
    break;
  }

  if (globalOpts.version) {
    printVersion();
    return;
  }

  if (!command) {
    printHelp();
    return;
  }

  if (command === 'help' || globalOpts.help) {
    printHelp();
    return;
  }

  if (!COMMANDS.has(command)) {
    throw new UsageError(`未知命令: ${command}`);
  }

  await dispatch(command, argv.slice(index), globalOpts);
}

main(process.argv.slice(2)).catch(error => {
  if (error instanceof UsageError) {
    printError(error.message);
    const firstToken = process.argv.slice(2).find(token => !token.startsWith('-'));
    if (firstToken === 'proxy') {
      console.log(c.dim('提示: 运行 `agy-aio proxy --help` 查看 proxy 用法。'));
    } else {
      console.log(c.dim('提示: 运行 `agy-aio --help` 查看用法。'));
    }
  } else {
    printError(error && error.message ? error.message : String(error));
  }
  process.exitCode = 1;
});
