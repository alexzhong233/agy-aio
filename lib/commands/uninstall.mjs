// `agy-aio uninstall` — remove injected patches and the capsule plugin while
// keeping official backups and user settings. Node built-ins only.

import {
  getPlatformInfo,
  detectInstallations,
  isAntigravityRunning,
  stopAntigravityProcesses
} from '../platform.mjs';
import { isPermissionError, resignAppBundle } from '../codesign.mjs';
import { getCdpStatus } from '../launcher.mjs';
import { uninstallCapsule } from '../modules/capsule.mjs';
import { uninstallLocalization } from '../modules/localization.mjs';
import { uninstallProxy } from '../modules/proxy.mjs';
import { banner, section, info, ok, warn, err, step, confirm } from '../ui.mjs';

const ALL_MODULES = ['localization', 'proxy', 'capsule'];
const MODULE_ALIASES = new Map([
  ['l10n', 'localization'],
  ['localization', 'localization'],
  ['chinese', 'localization'],
  ['proxy', 'proxy'],
  ['capsule', 'capsule']
]);

function toList(value) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : String(value).split(',');
  return items.map(item => String(item).trim().toLowerCase()).filter(Boolean);
}

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

function collectResignBundles(results) {
  const bundles = new Set();
  for (const result of results) {
    if (!result || !result.needsResign) continue;
    if (result.appBundlePath) bundles.add(result.appBundlePath);
    for (const bundle of result.modifiedAppBundles || []) bundles.add(bundle);
  }
  return [...bundles];
}

function reportProxy(result, dryRun) {
  if (!result) return;
  const count = (result.restoredTargets || []).length;
  if (dryRun) {
    info(`演练：将还原 ${count} 个代理目标。`);
    return;
  }
  if (result.restored && count > 0) ok(`已还原 ${count} 个代理目标，并删除注入的库文件。`);
  else info('没有需要还原的代理目标。');
}

function reportLocalization(result, dryRun) {
  if (!result) return;
  if (dryRun) {
    info('演练：将使用官方备份恢复 app.asar。');
    return;
  }
  if (result.restored) ok('已恢复官方 app.asar（备份文件保留）。');
  else if (result.alreadyOriginal) info('app.asar 已是官方原版，无需恢复。');
  else if (result.skipped) warn('未找到 Antigravity Desktop，已跳过汉化还原。');
}

function reportCapsule(result, dryRun) {
  if (!result) return;
  if (dryRun) {
    info(`演练：将移除插件目录 ${result.pluginDir}。`);
    return;
  }
  if (result.removed) {
    ok(`已移除 agy-capsule${result.settingsPreserved ? '（插件设置已保留）' : ''}。`);
  } else if (result.alreadyAbsent) {
    info('未安装 agy-capsule，跳过。');
  }
}

export async function runUninstall(opts = {}) {
  const {
    only,
    layers,
    skip,
    undoCdp = false,
    appDir = '',
    pluginsDir,
    dryRun = false,
    yes = false,
    env = process.env
  } = opts;

  banner(
    'agy-aio uninstall',
    dryRun ? '演练模式：只打印将要移除的内容' : '移除胶囊插件、汉化补丁与透明代理'
  );

  let modules;
  try {
    modules = normalizeModules({ only: only ?? layers, skip });
  } catch (error) {
    err(error.message);
    process.exitCode = 1;
    return { ok: false, error: error.message };
  }

  if (modules.length === 0) {
    warn('没有选中任何模块，未做任何修改。');
    return { ok: true, skipped: true, modules };
  }

  const platformInfo = getPlatformInfo({ env });
  const installations = detectInstallations({ appDir, platformInfo, env });
  info(`平台：${platformInfo.os}/${platformInfo.arch}，模块：${modules.join('、')}`);
  if (dryRun) warn('演练模式已开启：不会关闭进程、删除文件或执行重签。');

  if (!yes && !dryRun) {
    const proceed = await confirm(
      `即将移除：${modules.join('、')}。汉化备份与插件设置会保留。是否继续？`,
      { yes, defaultYes: false }
    );
    if (!proceed) {
      warn('已取消，未做任何修改。');
      return { ok: false, cancelled: true, modules };
    }
  }

  let proxyResult = null;
  let l10nResult = null;
  let capsuleResult = null;
  let resignedBundles = [];

  try {
    if (
      !dryRun &&
      (modules.includes('proxy') ||
        modules.includes('localization') ||
        (modules.includes('capsule') &&
          undoCdp &&
          getCdpStatus({ platformInfo, installations }).mode === 'native')) &&
      isAntigravityRunning()
    ) {
      info('正在关闭 Antigravity…');
      const stopped = await stopAntigravityProcesses({ timeoutMs: 5000 });
      if (!stopped || isAntigravityRunning()) {
        throw new Error('Antigravity 仍在运行，无法安全移除补丁。请手动退出后重试。');
      }
      ok('Antigravity 已关闭。');
    }

    section('移除补丁（按代理 → 汉化 → 插件顺序）');
    let index = 0;

    if (modules.includes('proxy')) {
      index += 1;
      step(index, modules.length, '移除透明代理');
      proxyResult = await uninstallProxy({
        appDir,
        dryRun,
        platformInfo,
        installations,
        env
      });
      reportProxy(proxyResult, dryRun);
    }

    if (modules.includes('localization')) {
      index += 1;
      step(index, modules.length, '还原官方 app.asar');
      l10nResult = uninstallLocalization({
        appDir,
        dryRun,
        platformInfo,
        installations,
        env
      });
      reportLocalization(l10nResult, dryRun);
    }

    if (modules.includes('capsule')) {
      index += 1;
      step(index, modules.length, '移除 agy-capsule 插件');
      capsuleResult = uninstallCapsule({
        pluginsDir,
        undoCdp,
        dryRun,
        platformInfo,
        installations,
        env
      });
      reportCapsule(capsuleResult, dryRun);
    }

    resignedBundles = collectResignBundles([l10nResult, proxyResult, capsuleResult]);
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
      ok('卸载完成。汉化备份与插件设置已保留，可随时重新安装。');
    }
    info('运行 agy-aio status 查看当前状态。');

    return {
      ok: true,
      dryRun,
      modules,
      platformInfo,
      proxy: proxyResult,
      localization: l10nResult,
      capsule: capsuleResult,
      resignedBundles
    };
  } catch (error) {
    if (!isPermissionError(error)) throw error;

    err('权限不足，无法修改 Antigravity 安装目录。');
    info('请选择以下任一方式后重试：');
    info('  1. sudo ./uninstall.sh');
    info('  2. sudo agy-aio uninstall');
    info('  3. 将 Antigravity.app 移到 ~/Applications（用户目录）后重新运行');
    process.exitCode = 1;
    return { ok: false, permissionError: true, error: error.message };
  }
}
