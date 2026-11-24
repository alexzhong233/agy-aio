// `agy-aio install` — install the capsule plugin, Chinese localization and the
// transparent proxy in one order-safe pass. Node built-ins only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getPlatformInfo,
  detectInstallations,
  isAntigravityRunning,
  stopAntigravityProcesses,
  detectLocalProxyPort
} from '../platform.mjs';
import { getConfigPath, loadConfig, saveConfig, updateProxyEndpoint } from '../config.mjs';
import { isPermissionError, resignAppBundle } from '../codesign.mjs';
import { getCdpStatus } from '../launcher.mjs';
import { getCapsuleStatus, installCapsule } from '../modules/capsule.mjs';
import { installLocalization } from '../modules/localization.mjs';
import { buildPosixProxy, ensureWindowsProxyAssets, installProxy } from '../modules/proxy.mjs';
import { banner, section, info, ok, warn, err, step, confirm } from '../ui.mjs';

const PROXY_SRC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'modules',
  'proxy-posix'
);

const ALL_MODULES = ['localization', 'proxy', 'capsule'];
const MODULE_ALIASES = new Map([
  ['l10n', 'localization'],
  ['localization', 'localization'],
  ['chinese', 'localization'],
  ['proxy', 'proxy'],
  ['capsule', 'capsule']
]);
const L10N_MODES = new Set(['auto', 'online', 'local']);

function toList(value) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : String(value).split(',');
  return items.map(item => String(item).trim().toLowerCase()).filter(Boolean);
}

// `--only`/`--layers` choose the initial set (default: everything); `--skip`
// removes from it. Aliases follow the CLI documentation.
function normalizeModules({ only, skip } = {}) {
  const requested = toList(only);
  const selected = new Set();

  for (const name of requested.length > 0 ? requested : ALL_MODULES) {
    const canonical = MODULE_ALIASES.get(name);
    if (!canonical) {
      throw new Error(`未知模块 "${name}"，可用模块：localization（l10n/chinese）、proxy、capsule`);
    }
    selected.add(canonical);
  }

  for (const name of toList(skip)) {
    const canonical = MODULE_ALIASES.get(name);
    if (!canonical) {
      throw new Error(`--skip 中的未知模块 "${name}"，可用模块：localization（l10n/chinese）、proxy、capsule`);
    }
    selected.delete(canonical);
  }

  return ALL_MODULES.filter(name => selected.has(name));
}

function posixArtifactsReady(platformInfo) {
  const libName =
    platformInfo.os === 'darwin' ? 'libantigravity_proxy.dylib' : 'libantigravity_proxy.so';
  const repoLib = path.join(PROXY_SRC_DIR, libName);
  const repoLauncher = path.join(PROXY_SRC_DIR, 'bin', 'anti-proxy-launcher');
  const cacheLib = path.join(platformInfo.dataDir, 'bin', libName);
  const cacheLauncher = path.join(platformInfo.dataDir, 'bin', 'anti-proxy-launcher');

  return (
    (fs.existsSync(repoLib) && fs.existsSync(repoLauncher)) ||
    (fs.existsSync(cacheLib) && fs.existsSync(cacheLauncher))
  );
}

function collectResignBundles(results) {
  const bundles = new Set();
  for (const result of results) {
    if (!result || !result.needsResign) continue;
    if (result.appBundlePath) bundles.add(result.appBundlePath);
    for (const bundle of result.modifiedAppBundles || []) bundles.add(bundle);
  }
  return [...bundles];
}

function reportLocalization(result, dryRun, mode) {
  if (!result) return;
  if (dryRun) {
    info(`演练：将以 ${mode} 模式汉化客户端 ${result.clientVersion || '（未知版本）'}。`);
    if (result.versionMatch === 'mismatch') {
      warn(
        result.compatibilityMessage ||
          '客户端与内置汉化版本不一致，auto 模式将要求在线匹配补丁（或使用 --allow-version-mismatch）。'
      );
    }
    return;
  }
  if (result.skipped && result.reason === 'antigravity-not-found') {
    warn('未找到 Antigravity Desktop，已跳过汉化。');
    return;
  }
  if (result.installed) {
    const method = result.method === 'online' ? '在线补丁' : '本地构建';
    ok(`汉化完成（${method}，客户端 ${result.clientVersion || '未知'}）。`);
  }
}

function reportProxy(result, dryRun) {
  if (!result) return;
  const count = Array.isArray(result.patchedTargets)
    ? result.patchedTargets.length
    : Array.isArray(result.deployedTargets)
      ? result.deployedTargets.length
      : 0;
  if (dryRun) {
    info(`演练：将为 ${count} 个目标注入代理。`);
    return;
  }
  if (result.installed) {
    ok(`透明代理已注入 ${count} 个目标。`);
  } else if (count === 0) {
    warn('未找到可注入的目标，透明代理未生效。');
  }
  if (result.needsResign) {
    info('代理修改了 Antigravity 应用包，将在步骤 C 统一重签。');
  }
}

function reportCapsule(result, dryRun) {
  if (!result) return;
  if (dryRun) {
    info(`演练：将把 agy-capsule ${result.version || ''} 安装到 ${result.pluginDir}。`);
    return;
  }
  if (result.installed) {
    ok(`agy-capsule ${result.version || ''} 已安装到 ${result.pluginDir}。`);
  }
}

export async function runInstall(opts = {}) {
  const {
    only,
    skip,
    proxyHost,
    proxyPort,
    proxyType,
    l10nMode = 'auto',
    allowVersionMismatch = false,
    cdpMode,
    noCdp = false,
    appDir = '',
    pluginsDir,
    forceConfig = false,
    rebuild = false,
    dryRun = false,
    yes = false,
    env = process.env
  } = opts;

  banner(
    'agy-aio install',
    dryRun ? '演练模式：只检查并打印计划，不修改任何文件' : '安装胶囊插件、中文汉化与透明代理'
  );

  let modules;
  try {
    modules = normalizeModules({ only, skip });
  } catch (error) {
    err(error.message);
    process.exitCode = 1;
    return { ok: false, error: error.message };
  }

  if (modules.length === 0) {
    warn('没有选中任何模块（--only 与 --skip 相互抵消），未做任何修改。');
    return { ok: true, skipped: true, modules };
  }

  if (!L10N_MODES.has(l10nMode)) {
    err(`不支持的汉化模式 "${l10nMode}"，可选：auto、online、local。`);
    process.exitCode = 1;
    return { ok: false, error: 'invalid-localization-mode' };
  }

  const platformInfo = getPlatformInfo({ env });
  const installations = detectInstallations({ appDir, platformInfo, env });
  const configPath = getConfigPath(platformInfo);

  // An explicit --cdp-mode wins; otherwise preserve an existing native injection
  // and fall back to the wrapper launcher. --no-cdp simply skips CDP setup.
  let effectiveCdpMode = 'wrapper';
  if (noCdp) {
    effectiveCdpMode = 'none';
  } else if (cdpMode) {
    effectiveCdpMode = cdpMode;
  } else if (modules.includes('capsule')) {
    effectiveCdpMode =
      getCdpStatus({ platformInfo, installations }).mode === 'native' ? 'native' : 'wrapper';
  }

  info(`平台：${platformInfo.os}/${platformInfo.arch}，模块：${modules.join('、')}`);
  if (dryRun) warn('演练模式已开启：不会关闭进程、写入文件或执行重签。');

  let configResult;
  try {
    configResult = loadConfig(configPath);
  } catch (error) {
    err(`无法读取配置 ${configPath}：${error.message}`);
    process.exitCode = 1;
    return { ok: false, error: error.message };
  }

  let config = configResult.config;
  let endpointChanged = false;

  try {
    if (!configResult.exists && proxyPort === undefined) {
      const detected = await detectLocalProxyPort({ env });
      if (detected) {
        config = updateProxyEndpoint(config, detected);
        endpointChanged = true;
        info(
          `未找到配置文件，已探测到本地代理 ${detected.host}:${detected.port} (${detected.type})，将使用该端点。`
        );
      } else if (modules.includes('proxy')) {
        warn('未探测到本地代理端口，将使用默认 127.0.0.1:7890 (socks5)。');
      }
    }

    if (proxyHost !== undefined || proxyPort !== undefined || proxyType !== undefined) {
      config = updateProxyEndpoint(config, { host: proxyHost, port: proxyPort, type: proxyType });
      endpointChanged = true;
    }
  } catch (error) {
    err(`代理端点无效：${error.message}`);
    process.exitCode = 1;
    return { ok: false, error: error.message };
  }

  if (endpointChanged) {
    if (dryRun) {
      info(`演练：将把代理端点写入 ${configPath}。`);
    } else {
      saveConfig(config, configPath, platformInfo);
      ok(`代理配置已写入 ${configPath}。`);
    }
  }

  const capsuleBefore = modules.includes('capsule')
    ? getCapsuleStatus({ pluginsDir, platformInfo, installations, env })
    : null;

  let l10nResult = null;
  let proxyResult = null;
  let capsuleResult = null;
  let windowsAssets = null;
  let resignedBundles = [];

  try {
    if (
      !dryRun &&
      (modules.includes('localization') ||
        modules.includes('proxy') ||
        (modules.includes('capsule') && effectiveCdpMode === 'native')) &&
      isAntigravityRunning()
    ) {
      const proceed = await confirm(
        '检测到 Antigravity 正在运行，应用补丁前需要关闭它。是否立即关闭？',
        { yes }
      );
      if (!proceed) {
        warn('已取消：请手动退出 Antigravity 后重新运行安装。');
        return { ok: false, cancelled: true, modules };
      }

      info('正在关闭 Antigravity…');
      const stopped = await stopAntigravityProcesses({ timeoutMs: 5000 });
      if (!stopped || isAntigravityRunning()) {
        throw new Error('Antigravity 仍在运行，无法安全写入补丁。请手动退出后重试。');
      }
      ok('Antigravity 已关闭。');
    }

    if (modules.includes('proxy') && !dryRun) {
      section('步骤 A · 准备透明代理组件');
      if (platformInfo.os === 'darwin' || platformInfo.os === 'linux') {
        if (rebuild || !posixArtifactsReady(platformInfo)) {
          info(rebuild ? '按 --rebuild 重新编译代理…' : '正在编译代理组件…');
          try {
            buildPosixProxy({ universal: true, platformInfo });
          } catch (error) {
            if (isPermissionError(error)) throw error;
            throw new Error(
              `透明代理编译失败：${error.message}。请确认已安装 make 与 C/C++ 工具链。`
            );
          }
          ok('代理组件已编译并缓存。');
        } else {
          ok('代理组件已就绪，跳过编译。');
        }
      } else if (platformInfo.os === 'win32') {
        info('正在下载并校验 Windows 代理 DLL…');
        windowsAssets = await ensureWindowsProxyAssets({
          arch: platformInfo.arch,
          platformInfo,
          env
        });
        ok(`Windows 代理组件就绪（${windowsAssets.tag} / ${windowsAssets.arch}）。`);
      } else {
        warn(`当前平台 ${platformInfo.os} 不支持透明代理。`);
      }
    }

    section('步骤 B · 应用补丁');
    let index = 0;

    if (modules.includes('localization')) {
      index += 1;
      step(index, modules.length, '应用中文汉化');
      l10nResult = await installLocalization({
        appDir,
        mode: l10nMode,
        dryRun,
        allowVersionMismatch,
        platformInfo,
        installations,
        env
      });
      reportLocalization(l10nResult, dryRun, l10nMode);
    }

    if (modules.includes('proxy')) {
      index += 1;
      step(index, modules.length, '注入透明代理');
      proxyResult = await installProxy({
        appDir,
        config,
        forceConfig,
        rebuild,
        dryRun,
        platformInfo,
        installations,
        env,
        windowsAssets
      });
      reportProxy(proxyResult, dryRun);
    }

    if (modules.includes('capsule')) {
      index += 1;
      step(index, modules.length, '安装 agy-capsule 插件');
      capsuleResult = installCapsule({
        pluginsDir,
        cdpMode: cdpMode || (noCdp ? undefined : effectiveCdpMode),
        setupCdp: !noCdp && effectiveCdpMode !== 'none',
        dryRun,
        platformInfo,
        installations,
        env
      });
      reportCapsule(capsuleResult, dryRun);
    }

    resignedBundles = collectResignBundles([l10nResult, proxyResult, capsuleResult]);
    if (resignedBundles.length > 0) {
      section('步骤 C · 统一重签 macOS 应用包');
      if (platformInfo.os !== 'darwin') {
        info('当前平台无需代码签名，跳过重签。');
      } else if (dryRun) {
        info(`演练：将对 ${resignedBundles.length} 个应用包统一重签。`);
      } else {
        for (const bundle of resignedBundles) {
          info(`重签 ${bundle}`);
          const signed = resignAppBundle(bundle);
          if (signed && signed.signed) ok(`已重签 ${bundle}。`);
          else warn(`重签未完成：${bundle}`);
        }
      }
    }
  } catch (error) {
    if (!isPermissionError(error)) throw error;

    err('权限不足，无法修改 Antigravity 安装目录。');
    info('请选择以下任一方式后重试：');
    info('  1. sudo ./install.sh');
    info('  2. sudo agy-aio install');
    info('  3. 将 Antigravity.app 移到 ~/Applications（用户目录）后重新运行');
    process.exitCode = 1;
    return { ok: false, permissionError: true, error: error.message };
  }

  section('后续步骤');
  const firstCapsuleInstall = Boolean(
    capsuleResult && capsuleResult.installed && capsuleBefore && !capsuleBefore.installed
  );
  if (firstCapsuleInstall) {
    info('首次安装 agy-capsule：请在 Antigravity 的「插件」面板中启用 agy-capsule。');
  }
  if (capsuleResult?.cdp?.mode === 'native') {
    info('已启用免壳 CDP：直接从程序坞或启动台打开原版 Antigravity 即可显示底栏胶囊。');
  } else if (modules.includes('capsule') || modules.includes('proxy')) {
    info('启动方式：macOS 使用 Antigravity-CDP.app；其他平台运行 agy-aio launch。');
  }
  info(dryRun ? '以上为演练结果，未修改任何文件。' : '运行 agy-aio status 查看安装状态。');

  return {
    ok: true,
    dryRun,
    modules,
    platformInfo,
    configPath,
    config,
    localization: l10nResult,
    proxy: proxyResult,
    capsule: capsuleResult,
    resignedBundles
  };
}
