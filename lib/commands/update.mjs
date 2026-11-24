// `agy-aio update` — compare bundled/local versions with upstream releases.

import fs from 'node:fs';
import path from 'node:path';

import { c, section, info, ok, warn, err as fail, table } from '../ui.mjs';
import { getPlatformInfo, detectInstallations } from '../platform.mjs';
import { getLatestRelease } from '../net.mjs';
import { getCapsuleStatus, updateCapsuleFromUpstream } from '../modules/capsule.mjs';
import {
  getLocalizationStatus,
  UPSTREAM_REPO as L10N_REPO
} from '../modules/localization.mjs';
import { ensureWindowsProxyAssets } from '../modules/proxy.mjs';

const CAPSULE_REPO = 'Lumidarin/agy-capsule';
const PROXY_REPO = 'yuaotian/antigravity-proxy';

function normalizeTag(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/^v/i, '');
}

function sameVersion(left, right) {
  const a = normalizeTag(left);
  const b = normalizeTag(right);
  return a !== '' && b !== '' && a === b;
}

function readProxyCacheTag(platformInfo) {
  const root = path.join(platformInfo.dataDir, 'cache', 'proxy-win');
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  const tags = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

  return tags.length > 0 ? tags[tags.length - 1] : null;
}

function collectLocalState({ platformInfo, installations, opts }) {
  const state = {
    capsule: { local: null, bundled: null, installed: false },
    localization: { local: null, bundled: null, localized: false, found: false },
    proxy: { local: null, bundled: null }
  };

  try {
    const status = getCapsuleStatus({
      pluginsDir: opts.pluginsDir,
      platformInfo,
      installations
    });
    state.capsule = {
      local: status.installedVersion || null,
      bundled: status.bundledVersion || null,
      installed: Boolean(status.installed)
    };
  } catch (error) {
    warn(`读取 agy-capsule 本地状态失败: ${error && error.message ? error.message : error}`);
  }

  try {
    const status = getLocalizationStatus({
      appDir: opts.appDir,
      platformInfo,
      installations
    });
    state.localization = {
      local: status.clientVersion || null,
      bundled: status.bundledVersion || null,
      localized: Boolean(status.localized),
      found: Boolean(status.found)
    };
  } catch (error) {
    warn(`读取本地化补丁状态失败: ${error && error.message ? error.message : error}`);
  }

  state.proxy.local = readProxyCacheTag(platformInfo);

  return state;
}

function statusLabel(localVersion, upstreamTag, { installed = true } = {}) {
  if (!upstreamTag) return c.red('检查失败');
  if (!localVersion) return installed ? c.dim('未知') : c.yellow('未安装');
  if (sameVersion(localVersion, upstreamTag)) return c.green('已是最新');
  return c.yellow('可更新');
}

function versionCell(primary, secondary, { installed = true, emptyLabel = '(未安装)' } = {}) {
  if (!primary) return installed ? c.dim('未知') : c.dim(emptyLabel);
  return secondary ? `${primary} ${c.dim(`(${secondary})`)}` : String(primary);
}

export async function runUpdate(opts = {}) {
  const platformInfo = getPlatformInfo();
  const installations = detectInstallations({ appDir: opts.appDir, platformInfo });
  const localState = collectLocalState({ platformInfo, installations, opts });

  section('检查上游更新');
  info('正在并行查询 GitHub 最新 Release…');

  const repos = [
    ['capsule', CAPSULE_REPO],
    ['localization', L10N_REPO],
    ['proxy', PROXY_REPO]
  ];

  const settled = await Promise.allSettled(repos.map(([, repo]) => getLatestRelease(repo)));

  const latest = {};
  const failures = [];
  settled.forEach((result, index) => {
    const [key, repo] = repos[index];
    if (result.status === 'fulfilled' && result.value && result.value.tag) {
      latest[key] = result.value.tag;
    } else {
      const reason = result.status === 'rejected' ? result.reason : new Error('未返回 release 信息');
      const message = reason && reason.message ? reason.message.split('\n')[0] : String(reason);
      failures.push({ key, repo, message });
      latest[key] = null;
    }
  });

  const rows = [
    [
      'agy-capsule',
      versionCell(localState.capsule.local, null, { installed: localState.capsule.installed }),
      localState.capsule.bundled || c.dim('-'),
      latest.capsule ? c.bold(latest.capsule) : c.red('检查失败'),
      statusLabel(localState.capsule.local, latest.capsule, { installed: localState.capsule.installed })
    ],
    [
      '中文本地化',
      versionCell(localState.localization.local, localState.localization.localized ? '已汉化' : null, {
        installed: localState.localization.found
      }),
      localState.localization.bundled || c.dim('-'),
      latest.localization ? c.bold(latest.localization) : c.red('检查失败'),
      statusLabel(localState.localization.local, latest.localization, {
        installed: localState.localization.found
      })
    ],
    [
      'Windows 代理资产',
      localState.proxy.local ? String(localState.proxy.local) : c.dim('(未缓存)'),
      c.dim('-'),
      latest.proxy ? c.bold(latest.proxy) : c.red('检查失败'),
      statusLabel(localState.proxy.local, latest.proxy, { installed: Boolean(localState.proxy.local) })
    ]
  ];

  table(rows, ['组件', '本地/已安装', '内置/缓存', '上游最新', '状态']);

  for (const failure of failures) {
    warn(`${failure.repo} 查询失败: ${failure.message}`);
  }
  if (failures.length > 0) {
    warn('GitHub API 可能被限流，可设置 GITHUB_TOKEN 后重试。');
  }

  if (!opts.apply) {
    info('使用 `agy-aio update --apply` 更新内置组件。');
    return { latest, local: localState, applied: false };
  }

  section(opts.dryRun ? '应用更新（dry-run）' : '应用更新');
  let applyFailed = false;

  try {
    const result = await updateCapsuleFromUpstream({
      pluginsDir: opts.pluginsDir,
      dryRun: Boolean(opts.dryRun),
      platformInfo
    });
    if (result && result.dryRun) {
      info(`[dry-run] 将把 agy-capsule 更新到 ${result.tag || '上游最新版'}（当前 ${result.currentVersion || '未知'}）。`);
    } else {
      ok(`agy-capsule 已更新${result && result.tag ? ` 到 ${result.tag}` : ''}。`);
    }
  } catch (error) {
    applyFailed = true;
    fail(`agy-capsule 更新失败: ${error && error.message ? error.message : error}`);
  }

  if (platformInfo.os === 'win32') {
    try {
      const assets = await ensureWindowsProxyAssets({
        dryRun: Boolean(opts.dryRun),
        platformInfo
      });
      if (assets && assets.dryRun) {
        info(`[dry-run] 将缓存 Windows 代理资产 ${assets.tag || ''} (${assets.arch || platformInfo.arch})。`);
      } else {
        ok(`Windows 代理资产已缓存${assets && assets.tag ? ` (${assets.tag})` : ''}。`);
      }
    } catch (error) {
      warn(`Windows 代理资产预缓存失败: ${error && error.message ? error.message : error}`);
    }
  }

  console.log('');
  info('下一步:');
  info('  1. 完全退出并重新启动 Antigravity，使更新后的组件生效。');
  info('  2. 如客户端更新覆盖了本地化/代理补丁，请运行 `agy-aio restore` 重新应用。');
  info('  3. 运行 `agy-aio status` 复查安装状态。');

  if (applyFailed) process.exitCode = 1;

  return { latest, local: localState, applied: true, applyFailed };
}
