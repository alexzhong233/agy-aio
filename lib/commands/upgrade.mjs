// `agy-aio upgrade` — upgrade the official Antigravity desktop client and
// selectively re-apply the patches that were active before the swap.
// Node built-ins only.

import {
  getPlatformInfo,
  detectInstallations,
  isAntigravityRunning,
  stopAntigravityProcesses
} from '../platform.mjs';
import { getConfigPath, loadConfig } from '../config.mjs';
import { isPermissionError, resignAppBundle } from '../codesign.mjs';
import { setupCdpLauncher, getCdpStatus } from '../launcher.mjs';
import { getLocalizationStatus, restoreLocalization } from '../modules/localization.mjs';
import { getProxyStatus, installProxy } from '../modules/proxy.mjs';
import { getClientUpdateStatus, upgradeClient } from '../modules/client-upgrade.mjs';
import { c, banner, section, info, ok, warn, err, step, confirm, table } from '../ui.mjs';

const L10N_MODES = new Set(['auto', 'online', 'local']);
const CDP_MODES = new Set(['native', 'wrapper', 'none']);

const CODESIGN_LABELS = {
  google: 'Google 官方签名',
  adhoc: 'ad-hoc 签名',
  unsigned: '未签名',
  missing: '文件缺失',
  unknown: '未知',
  'not-applicable': '不适用'
};

function collectResignBundles(results) {
  const bundles = new Set();
  for (const result of results) {
    if (!result || !result.needsResign) continue;
    if (result.appBundlePath) bundles.add(result.appBundlePath);
    for (const bundle of result.modifiedAppBundles || []) bundles.add(bundle);
  }
  return [...bundles];
}

function reportLocalization(result, mode) {
  if (!result) return;
  if (result.installed) {
    const method = result.method === 'online' ? '在线补丁' : '本地构建';
    ok(`汉化已恢复（${mode} / ${method}，客户端 ${result.clientVersion || '未知'}）。`);
  }
}

function reportProxy(result) {
  if (!result) return;
  const count = Array.isArray(result.patchedTargets)
    ? result.patchedTargets.length
    : Array.isArray(result.deployedTargets)
      ? result.deployedTargets.length
      : 0;
  if (result.installed) ok(`透明代理已重新注入 ${count} 个目标。`);
  else if (count === 0) warn('未找到可注入的目标，透明代理未生效。');
}

function reportCdp(result) {
  if (!result) return;
  if (result.skipped) {
    warn(`CDP 启动器未创建：${result.reason || '当前平台不支持'}。`);
  } else if (result.configured) {
    ok('CDP 启动器已就绪。');
  }
}

export async function runUpgrade(opts = {}) {
  const {
    check = false,
    noRestore = false,
    force = false,
    packagePath = '',
    l10nMode = 'auto',
    allowVersionMismatch = false,
    cdpMode,
    noCdp = false,
    appDir = '',
    pluginsDir,
    dryRun = false,
    yes = false,
    json = false,
    env = process.env
  } = opts;

  if (!L10N_MODES.has(l10nMode)) {
    err(`不支持的汉化模式 "${l10nMode}"，可选：auto、online、local。`);
    process.exitCode = 1;
    return { ok: false, error: 'invalid-localization-mode' };
  }
  if (cdpMode !== undefined && !CDP_MODES.has(cdpMode)) {
    err(`不支持的 CDP 模式 "${cdpMode}"，可选：native、wrapper、none。`);
    process.exitCode = 1;
    return { ok: false, error: 'invalid-cdp-mode' };
  }

  const platformInfo = getPlatformInfo({ env });
  const installations = detectInstallations({ appDir, platformInfo, env });

  if (check) {
    const status = await getClientUpdateStatus({
      appDir,
      platformInfo,
      installations,
      env,
      checkRemote: true
    });

    if (json) {
      console.log(JSON.stringify(status, null, 2));
      return { ok: true, checked: true, status };
    }

    banner('agy-aio upgrade', '检查官方 Antigravity 客户端版本与待安装更新');
    table(
      [
        ['当前版本', status.clientVersion || c.dim('未知')],
        [
          '官方最新',
          status.latestVersion || (status.remoteError ? c.red('检查失败') : c.dim('未知'))
        ],
        [
          '应用签名',
          CODESIGN_LABELS[status.appCodesign] || status.appCodesign || c.dim('未知')
        ],
        [
          'macOS 内置更新',
          platformInfo.os !== 'darwin'
            ? c.dim('不适用')
            : status.autoUpdateBlocked
              ? c.red('已阻止（非官方签名）')
              : status.appCodesign === 'google'
                ? c.green('可用')
                : c.yellow('未知')
        ],
        [
          '本地待安装缓存',
          status.pendingUpdate && status.pendingUpdate.exists
            ? c.green(status.pendingUpdate.fileName || '已就绪')
            : c.dim('无')
        ],
        [
          '缓存校验',
          status.pendingMatchesLatest
            ? c.green('匹配官方最新')
            : status.pendingUpdate && status.pendingUpdate.exists
              ? c.yellow('未匹配官方最新')
              : c.dim('—')
        ]
      ],
      ['项目', '状态']
    );

    if (status.remoteError) {
      warn(`无法获取官方版本信息：${status.remoteError}`);
      info('网络恢复后可重新运行 `agy-aio upgrade --check`。');
    }
    if (status.autoUpdateBlocked) {
      warn('当前应用不是 Google 官方签名，macOS 内置自动更新已被阻止，请使用 agy-aio upgrade 升级。');
    }
    if (status.updateAvailable === true && !status.remoteError) {
      info('发现新版本，可运行 `agy-aio upgrade` 升级（演练：`agy-aio upgrade --dry-run`）。');
    } else if (status.pendingAvailable) {
      info('检测到本地待安装缓存，可运行 `agy-aio upgrade` 完成升级。');
    } else {
      info('使用 `agy-aio upgrade` 升级客户端，或 `agy-aio upgrade --dry-run` 预览方案。');
    }

    return { ok: true, checked: true, status };
  }

  banner(
    'agy-aio upgrade',
    dryRun
      ? '演练模式：只检查升级方案，不修改客户端'
      : '升级官方 Antigravity 客户端并自动恢复已启用补丁'
  );

  if (dryRun) warn('演练模式已开启：不会关闭进程、下载安装包、写入文件或执行重签。');

  let configResult;
  try {
    configResult = loadConfig(getConfigPath(platformInfo));
  } catch (error) {
    err(`无法读取配置：${error && error.message ? error.message : error}`);
    process.exitCode = 1;
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }

  try {
    // Snapshot the layers that are active before the official client is swapped.
    const prevL10n = getLocalizationStatus({ appDir, platformInfo, installations, env });
    const restoreL10n = Boolean(prevL10n.localized);
    const prevProxy = await getProxyStatus({
      appDir,
      config: configResult.config,
      platformInfo,
      installations,
      env
    });
    const restoreProxy =
      Array.isArray(prevProxy.targets) && prevProxy.targets.some(target => target && target.patched);
    const prevCdp = getCdpStatus({ platformInfo, installations });
    const effectiveCdpMode = noCdp
      ? 'none'
      : cdpMode || (prevCdp.mode === 'native' || prevCdp.mode === 'wrapper' ? prevCdp.mode : 'none');

    info(`平台：${platformInfo.os}/${platformInfo.arch}`);
    info(
      `升级后计划恢复：localization=${restoreL10n}、proxy=${restoreProxy}、cdp=${effectiveCdpMode}。`
    );

    const upgradeResult = await upgradeClient({
      appDir,
      packagePath,
      dryRun,
      force,
      env,
      platformInfo,
      installations,
      beforeSwap: async ({ previousVersion, newVersion, source }) => {
        if (!yes) {
          const proceed = await confirm(
            `即将把 Antigravity 从 ${previousVersion || '未知'} 升级到 ${
              newVersion || '最新版'
            }（来源：${source}）。替换前将关闭正在运行的 Antigravity，是否继续？`,
            { yes }
          );
          if (!proceed) return false;
        }

        if (isAntigravityRunning()) {
          info('正在关闭 Antigravity…');
          const stopped = await stopAntigravityProcesses({ timeoutMs: 5000 });
          if (!stopped || isAntigravityRunning()) {
            throw new Error('Antigravity 仍在运行，无法安全升级。请手动退出后重试。');
          }
          ok('Antigravity 已关闭。');
        }
        return true;
      }
    });

    if (upgradeResult.skipped) {
      warn('未检测到 Antigravity Desktop 安装');
      return { ok: true, dryRun, upgrade: upgradeResult };
    }

    if (upgradeResult.alreadyLatest) {
      ok(
        `Antigravity 已是最新版本 (${
          upgradeResult.previousVersion || upgradeResult.newVersion || '未知'
        })。`
      );
      return { ok: true, dryRun, upgrade: upgradeResult };
    }

    if (upgradeResult.cancelled) {
      warn('已取消，未修改 Antigravity。');
      return { ok: false, cancelled: true, upgrade: upgradeResult };
    }

    if (upgradeResult.dryRun) {
      info(
        `演练：来源 ${upgradeResult.source || '未知'}，将把 Antigravity 从 ${
          upgradeResult.previousVersion || '未知'
        } 升级到 ${upgradeResult.newVersion || '最新版'}。`
      );
      info(
        `演练：计划选择性恢复 localization=${restoreL10n}、proxy=${restoreProxy}、cdp=${effectiveCdpMode}。`
      );
      info('演练：未修改任何文件。');
      return {
        ok: true,
        dryRun: true,
        upgrade: upgradeResult,
        restorePlan: {
          localization: restoreL10n,
          proxy: restoreProxy,
          cdpMode: effectiveCdpMode
        }
      };
    }

    if (upgradeResult.manualInstallRequired) {
      ok(upgradeResult.message);
      return { ok: true, upgrade: upgradeResult };
    }

    if (upgradeResult.upgraded === true) {
      ok(
        `已将 Antigravity 升级至 ${upgradeResult.newVersion || '最新版'}（来源：${upgradeResult.source}）。`
      );

      let l10nResult = null;
      let proxyResult = null;
      let cdpResult = null;
      let localizationWarning = null;
      let resignedBundles = [];

      if (!noRestore) {
        const freshInstalls = detectInstallations({ appDir, platformInfo, env });
        const restoreSteps =
          (restoreL10n ? 1 : 0) + (restoreProxy ? 1 : 0) + (effectiveCdpMode !== 'none' ? 1 : 0);
        let restoreIndex = 0;

        if (restoreSteps === 0) {
          info('升级前未启用需要重注入的补丁，跳过恢复。');
        } else {
          section('恢复已启用的补丁');
        }

        if (restoreL10n) {
          restoreIndex += 1;
          step(restoreIndex, restoreSteps, '重新应用中文汉化');
          try {
            l10nResult = await restoreLocalization({
              appDir,
              mode: l10nMode,
              dryRun: false,
              allowVersionMismatch,
              platformInfo,
              installations: freshInstalls,
              env
            });
            reportLocalization(l10nResult, l10nMode);
          } catch (error) {
            // A version mismatch (upstream localization not yet released for the
            // brand-new client) must not stop proxy/CDP restoration. Keeping the
            // official app.asar avoids a white screen from a mismatched patch.
            localizationWarning = error && error.message ? error.message : String(error);
            warn(`汉化恢复已跳过：${localizationWarning}`);
            warn('已保留官方 app.asar，避免汉化补丁版本不匹配导致白屏；代理与 CDP 恢复将继续。');
          }
        }

        if (restoreProxy) {
          restoreIndex += 1;
          step(restoreIndex, restoreSteps, '重新应用透明代理');
          proxyResult = await installProxy({
            appDir,
            config: configResult.config,
            forceConfig: false,
            dryRun: false,
            platformInfo,
            installations: freshInstalls,
            env
          });
          reportProxy(proxyResult);
        }

        if (effectiveCdpMode !== 'none') {
          restoreIndex += 1;
          step(restoreIndex, restoreSteps, '确保 CDP 启动器');
          cdpResult = setupCdpLauncher({
            mode: effectiveCdpMode,
            dryRun: false,
            platformInfo,
            installations: freshInstalls
          });
          reportCdp(cdpResult);
        }

        resignedBundles = collectResignBundles([l10nResult, proxyResult, cdpResult]);
        if (platformInfo.os === 'darwin' && resignedBundles.length > 0) {
          section('统一重签 macOS 应用包');
          for (const bundle of resignedBundles) {
            info(`重签 ${bundle}`);
            const signed = resignAppBundle(bundle);
            if (signed && signed.signed) ok(`已重签 ${bundle}。`);
            else warn(`重签未完成：${bundle}`);
          }
        }
      } else {
        info('已按 --no-restore 跳过补丁恢复。');
      }

      section('完成');
      ok('升级完成。');
      if (noRestore || effectiveCdpMode === 'none') {
        warn(
          `未启用 CDP 启动器（${noCdp ? '--no-cdp' : effectiveCdpMode === 'none' ? '--cdp-mode=none' : '--no-restore'}），agy-capsule 可能无法连接。`
        );
      } else if (cdpResult?.mode === 'native') {
        info('已启用免壳 CDP：直接从程序坞或启动台打开原版 Antigravity 即可显示底栏胶囊。');
      } else {
        info('启动方式：macOS 使用 Antigravity-CDP.app；其他平台运行 agy-aio launch。');
      }
      info('请完全退出并重新启动 Antigravity，使升级与恢复的补丁生效。');
      info('运行 agy-aio status 可复查客户端与补丁状态。');

      return {
        ok: true,
        dryRun: false,
        upgrade: upgradeResult,
        localization: l10nResult,
        localizationWarning,
        proxy: proxyResult,
        cdp: cdpResult,
        resignedBundles
      };
    }

    warn('Antigravity 未执行升级。');
    return { ok: false, upgrade: upgradeResult };
  } catch (error) {
    if (!isPermissionError(error)) throw error;

    err('权限不足，无法升级 Antigravity 客户端。');
    info('请选择以下任一方式后重试：');
    info('  1. sudo node bin/agy-aio.mjs upgrade');
    info('  2. sudo agy-aio upgrade');
    info('  3. 将 Antigravity.app 移到 ~/Applications（用户目录）后重新运行');
    process.exitCode = 1;
    return { ok: false, permissionError: true, error: error.message };
  }
}
