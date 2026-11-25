// `agy-aio status` — read-only diagnostic report for every layer.
// Node built-ins only.

import {
  getPlatformInfo,
  detectInstallations,
  isAntigravityRunning
} from '../platform.mjs';
import { getConfigPath, getDefaultConfig, loadConfig } from '../config.mjs';
import { getCapsuleStatus } from '../modules/capsule.mjs';
import { getLocalizationStatus } from '../modules/localization.mjs';
import { getProxyStatus } from '../modules/proxy.mjs';
import { getClientUpdateStatus } from '../modules/client-upgrade.mjs';
import { compareVersions } from '../version.mjs';
import { c, banner, section, info, ok, warn, table } from '../ui.mjs';

const OS_LABELS = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux'
};

const CODESIGN_LABELS = {
  google: 'Google 官方签名',
  adhoc: 'ad-hoc 签名',
  unsigned: '未签名',
  missing: '文件缺失',
  unknown: '未知',
  'not-applicable': '不适用'
};

function osLabel(os) {
  return OS_LABELS[os] || String(os || '未知');
}

function flag(value, yes, no) {
  return value ? c.green(yes) : c.yellow(no);
}

function installationRows(installations) {
  const rows = [];
  const groups = [
    ['Desktop', installations.desktop],
    ['IDE', installations.ide],
    ['CLI', installations.cli]
  ];

  for (const [kind, entries] of groups) {
    for (const entry of entries || []) {
      rows.push([kind, entry.name || kind, entry.rootDir || entry.exePath || '—']);
    }
  }

  return rows;
}

function printCapsule(capsule) {
  const cdpState =
    capsule.cdp?.mode === 'native'
      ? c.green('免壳原生注入 (原版 App 直接生效)')
      : capsule.cdp?.configured
        ? c.green('独立启动器 (Antigravity-CDP.app / 快捷方式)')
        : c.yellow('未配置');

  section('胶囊插件（agy-capsule）');
  table(
    [
      ['安装状态', flag(capsule.installed, '已安装', '未安装')],
      ['已安装版本', capsule.installedVersion || '—'],
      ['内置版本', capsule.bundledVersion || '—'],
      ['CDP 启动器', cdpState]
    ],
    ['项目', '状态']
  );
  info(`插件目录：${capsule.pluginDir}`);

  if (capsule.cdp && capsule.cdp.launchers && capsule.cdp.launchers.length > 0) {
    info(`启动器路径：${capsule.cdp.launchers.join(', ')}`);
  }
  if (capsule.cdp && capsule.cdp.supported === false) {
    warn('当前平台不支持自动配置 CDP 启动器。');
  }
  if (capsule.installed && capsule.installedVersion && capsule.bundledVersion) {
    const cmp = compareVersions(capsule.installedVersion, capsule.bundledVersion);
    if (cmp !== null && cmp < 0) {
      warn('已安装版本低于内置版本，可运行 agy-aio install 或 agy-aio update --apply 更新插件。');
    } else if (cmp !== null && cmp > 0) {
      info('已安装版本高于仓库内置版本（来自上游最新 Release）。');
    } else if (cmp === null && capsule.installedVersion !== capsule.bundledVersion) {
      warn('已安装版本与内置版本不一致，可运行 agy-aio install 更新插件。');
    }
  }
}

function printLocalization(localization) {
  section('中文汉化');
  if (!localization.found) {
    warn('未找到 Antigravity Desktop 的 app.asar，无法检查汉化状态。');
    return;
  }

  const backupState = localization.hasValidBackup
    ? c.green('有效')
    : localization.backupExists
      ? c.yellow('存在但版本不匹配')
      : c.yellow('未找到');

  const versionMatchState =
    localization.versionMatch === 'match'
      ? c.green('匹配')
      : localization.versionMatch === 'mismatch'
        ? c.red('不匹配（存在白屏风险）')
        : c.yellow('未知');

  table(
    [
      ['客户端版本', localization.clientVersion || '未知'],
      ['内置补丁版本', localization.bundledVersion || '未知'],
      ['版本匹配', versionMatchState],
      ['汉化状态', flag(localization.localized, '已汉化', '未汉化')],
      ['官方原版备份', backupState],
      ['备份版本', localization.backupVersion || '—']
    ],
    ['项目', '状态']
  );

  if (localization.versionMatch === 'mismatch') {
    warn(
      localization.compatibilityMessage ||
        '客户端版本与内置汉化补丁版本不一致，请先运行 agy-aio update 检查匹配版本。'
    );
  }

  if (localization.localized && !localization.hasValidBackup) {
    warn('缺少可用的官方原版备份，卸载前请先准备与当前客户端版本一致的官方 app.asar。');
  }
}

function printProxy(proxy, configResult) {
  section('透明代理');
  const endpoint = proxy.proxy || {};
  const endpointText =
    endpoint.host && endpoint.port
      ? `${endpoint.host}:${endpoint.port} (${endpoint.type || '未知'})`
      : '未配置';

  table(
    [
      ['代理端点', endpointText],
      ['本地端口', flag(proxy.portOpen, '可连通', '无法连接')],
      ['构建/缓存组件', flag(proxy.artifactsReady, '就绪', '缺失')],
      ['配置文件', configResult.exists ? c.green('已写入') : c.yellow('未创建（使用默认值）')]
    ],
    ['项目', '状态']
  );

  const targets = proxy.targets || [];
  if (targets.length === 0) {
    info('未发现可注入的目标二进制或 DLL。');
    return;
  }

  if (proxy.os === 'win32') {
    table(
      targets.map(target => [
        `${target.name} · ${target.targetDir || '—'}`,
        target.kind === 'cli'
          ? `dbghelp.dll ${target.dbghelpDllExists ? '有' : '无'} · antigravity_proxy.dll ${
              target.proxyDllExists ? '有' : '无'
            }`
          : `version.dll ${target.versionDllExists ? '有' : '无'}`,
        flag(target.patched, '已注入', '未注入'),
        flag(target.configJsonExists, '已同步', '未同步')
      ]),
      ['目标', 'DLL', '补丁', '配置']
    );
    return;
  }

  table(
    targets.map(target => [
      `${target.name} · ${target.targetPath}`,
      flag(target.patched, '已注入', '未注入'),
      CODESIGN_LABELS[target.codesign] || target.codesign || '未知',
      flag(target.origExists, '已备份', '无备份')
    ]),
    ['目标', '补丁', '签名', '原文件备份']
  );
}

export async function runStatus(opts = {}) {
  const { json = false, appDir = '', pluginsDir, env = process.env } = opts;

  const platformInfo = getPlatformInfo({ env });
  const installations = detectInstallations({ appDir, platformInfo, env });
  const configPath = getConfigPath(platformInfo);

  let configResult;
  try {
    configResult = loadConfig(configPath);
  } catch (error) {
    configResult = {
      config: getDefaultConfig(),
      exists: false,
      path: configPath,
      error: error.message
    };
  }

  const running = isAntigravityRunning();
  const capsule = getCapsuleStatus({ pluginsDir, platformInfo, installations, env });
  const localization = getLocalizationStatus({ appDir, platformInfo, installations, env });
  const proxy = await getProxyStatus({
    appDir,
    config: configResult.config,
    platformInfo,
    installations,
    env
  });

  let clientUpdate;
  try {
    clientUpdate = await getClientUpdateStatus({
      appDir,
      platformInfo,
      installations,
      env,
      checkRemote: false
    });
  } catch (error) {
    clientUpdate = { error: error && error.message ? error.message : String(error) };
  }

  const status = {
    platform: platformInfo,
    node: process.version,
    running,
    installations,
    capsule,
    localization,
    proxy,
    clientUpdate
  };

  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return status;
  }

  banner('agy-aio 状态报告', `${osLabel(platformInfo.os)} · ${platformInfo.arch} · Node ${process.version}`);

  section('系统环境');
  table(
    [
      ['操作系统', `${osLabel(platformInfo.os)} (${platformInfo.os})`],
      ['架构', platformInfo.arch],
      ['Node 版本', process.version],
      ['运行状态', running ? c.yellow('运行中') : '未运行']
    ],
    ['项目', '值']
  );
  info(`配置文件：${configPath}`);
  if (configResult.error) {
    warn(`配置文件无法解析：${configResult.error}`);
  }

  section('Antigravity 安装路径');
  const rows = installationRows(installations);
  if (rows.length === 0) {
    warn('未检测到本机 Antigravity 安装（Desktop / IDE / CLI）。');
  } else {
    ok(`已检测到 ${rows.length} 个安装目标。`);
    table(rows, ['类型', '名称', '路径']);
  }

  if (platformInfo.os === 'darwin') {
    const signature = CODESIGN_LABELS[clientUpdate.appCodesign] || clientUpdate.appCodesign || '未知';
    info(`应用签名：${signature}`);
    if (
      clientUpdate.autoUpdateBlocked ||
      (clientUpdate.pendingUpdate && clientUpdate.pendingUpdate.exists)
    ) {
      if (clientUpdate.autoUpdateBlocked) {
        warn('应用签名非 Google 官方签名，macOS 内置自动更新可能不可用。');
      }
      if (clientUpdate.pendingUpdate && clientUpdate.pendingUpdate.exists) {
        info(`检测到本地待安装更新缓存：${clientUpdate.pendingUpdate.fileName || '已就绪'}。`);
      }
      info('可运行 `agy-aio upgrade --check` 检查官方版本，或 `agy-aio upgrade` 完成升级。');
    }
  }
  if (clientUpdate.error) {
    warn(`客户端更新状态检查失败：${clientUpdate.error}`);
  }

  printCapsule(capsule);
  printLocalization(localization);
  printProxy(proxy, configResult);

  info('运行 agy-aio install 安装缺失组件；Antigravity 更新后运行 agy-aio restore 恢复补丁。');

  return status;
}
