// `agy-aio restore` — re-apply localization, proxy and the CDP launcher after
// an Antigravity update replaces the patched files. Node built-ins only.

import {
  getPlatformInfo,
  detectInstallations,
  isAntigravityRunning,
  stopAntigravityProcesses
} from '../platform.mjs';
import { getConfigPath, loadConfig } from '../config.mjs';
import { isPermissionError, resignAppBundle } from '../codesign.mjs';
import { setupCdpLauncher, getCdpStatus } from '../launcher.mjs';
import { restoreLocalization } from '../modules/localization.mjs';
import { installProxy } from '../modules/proxy.mjs';
import { banner, section, info, ok, warn, err, step, confirm } from '../ui.mjs';

const L10N_MODES = new Set(['auto', 'online', 'local']);

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
    info(`演练：将以 ${mode} 模式重新汉化客户端 ${result.clientVersion || '（未知版本）'}。`);
    return;
  }
  if (result.skipped && result.reason === 'antigravity-not-found') {
    warn('未找到 Antigravity Desktop，已跳过汉化恢复。');
    return;
  }
  if (result.installed) {
    const method = result.method === 'online' ? '在线补丁' : '本地构建';
    ok(`汉化已恢复（${method}，客户端 ${result.clientVersion || '未知'}）。`);
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
    info(`演练：将为 ${count} 个目标重新注入代理。`);
    return;
  }
  if (result.installed) ok(`透明代理已重新注入 ${count} 个目标。`);
  else if (count === 0) warn('未找到可注入的目标，透明代理未生效。');
}

function reportCdp(result, dryRun) {
  if (!result) return;
  if (dryRun) {
    info('演练：将确认或创建 CDP 启动器。');
    return;
  }
  if (result.skipped) {
    warn(`CDP 启动器未创建：${result.reason || '当前平台不支持'}。`);
  } else if (result.configured) {
    ok('CDP 启动器已就绪。');
  }
}

export async function runRestore(opts = {}) {
  const {
    l10nMode = 'auto',
    allowVersionMismatch = false,
    appDir = '',
    cdpMode,
    noCdp = false,
    dryRun = false,
    yes = false,
    env = process.env
  } = opts;

  banner(
    'agy-aio restore',
    dryRun ? '演练模式：只检查将恢复的内容' : 'Antigravity 更新后，一键恢复汉化、代理与 CDP 启动器'
  );

  if (!L10N_MODES.has(l10nMode)) {
    err(`不支持的汉化模式 "${l10nMode}"，可选：auto、online、local。`);
    process.exitCode = 1;
    return { ok: false, error: 'invalid-localization-mode' };
  }

  const platformInfo = getPlatformInfo({ env });
  const installations = detectInstallations({ appDir, platformInfo, env });
  const configPath = getConfigPath(platformInfo);
  const effectiveCdpMode = noCdp
    ? 'none'
    : cdpMode ||
      (getCdpStatus({ platformInfo, installations }).mode === 'native' ? 'native' : 'wrapper');

  let configResult;
  try {
    configResult = loadConfig(configPath);
  } catch (error) {
    err(`无法读取配置 ${configPath}：${error.message}`);
    process.exitCode = 1;
    return { ok: false, error: error.message };
  }

  info(`平台：${platformInfo.os}/${platformInfo.arch}`);
  if (dryRun) warn('演练模式已开启：不会关闭进程、写入文件或执行重签。');

  let l10nResult = null;
  let proxyResult = null;
  let cdpResult = null;
  let resignedBundles = [];

  try {
    if (!dryRun && isAntigravityRunning()) {
      const proceed = await confirm(
        '恢复补丁前需要关闭正在运行的 Antigravity。是否立即关闭？',
        { yes }
      );
      if (!proceed) {
        warn('已取消：请手动退出 Antigravity 后重新运行 restore。');
        return { ok: false, cancelled: true };
      }

      info('正在关闭 Antigravity…');
      const stopped = await stopAntigravityProcesses({ timeoutMs: 5000 });
      if (!stopped || isAntigravityRunning()) {
        throw new Error('Antigravity 仍在运行，无法安全恢复补丁。请手动退出后重试。');
      }
      ok('Antigravity 已关闭。');
    }

    section('恢复补丁');
    const totalSteps = effectiveCdpMode === 'none' ? 2 : 3;
    let index = 0;

    index += 1;
    step(index, totalSteps, '重新应用中文汉化');
    l10nResult = await restoreLocalization({
      appDir,
      mode: l10nMode,
      dryRun,
      allowVersionMismatch,
      platformInfo,
      installations,
      env
    });
    reportLocalization(l10nResult, dryRun, l10nMode);

    index += 1;
    step(index, totalSteps, '重新应用透明代理');
    proxyResult = await installProxy({
      appDir,
      config: configResult.config,
      forceConfig: false,
      dryRun,
      platformInfo,
      installations,
      env
    });
    reportProxy(proxyResult, dryRun);

    if (effectiveCdpMode !== 'none') {
      index += 1;
      step(index, totalSteps, '确保 CDP 启动器');
      cdpResult = setupCdpLauncher({ mode: effectiveCdpMode, dryRun, platformInfo, installations });
      reportCdp(cdpResult, dryRun);
    }

    resignedBundles = collectResignBundles([l10nResult, proxyResult, cdpResult]);
    if (platformInfo.os === 'darwin' && resignedBundles.length > 0) {
      section('统一重签 macOS 应用包');
      if (dryRun) {
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

    section('完成');
    if (dryRun) {
      info('以上为演练结果，未做任何修改。');
    } else {
      ok('补丁已恢复。');
    }
    if (effectiveCdpMode === 'none') {
      warn(
        `已跳过 CDP 启动器（${noCdp ? '--no-cdp' : '--cdp-mode=none'}），agy-capsule 可能无法连接。`
      );
    } else if (cdpResult?.mode === 'native') {
      info('已启用免壳 CDP：直接从程序坞或启动台打开原版 Antigravity 即可显示底栏胶囊。');
    } else {
      info('启动方式：macOS 使用 Antigravity-CDP.app；其他平台运行 agy-aio launch。');
    }

    return {
      ok: true,
      dryRun,
      platformInfo,
      configPath,
      localization: l10nResult,
      proxy: proxyResult,
      cdp: cdpResult,
      resignedBundles
    };
  } catch (error) {
    if (!isPermissionError(error)) throw error;

    err('权限不足，无法恢复 Antigravity 补丁。');
    info('请选择以下任一方式后重试：');
    info('  1. sudo node bin/agy-aio.mjs restore');
    info('  2. sudo agy-aio restore');
    info('  3. 将 Antigravity.app 移到 ~/Applications（用户目录）后重新运行');
    process.exitCode = 1;
    return { ok: false, permissionError: true, error: error.message };
  }
}
