// `agy-aio update` — compare bundled/local versions with upstream releases.

import fs from 'node:fs';
import path from 'node:path';

import { c, section, info, ok, warn, err as fail, table, confirm } from '../ui.mjs';
import { getPlatformInfo, detectInstallations, isAntigravityRunning, stopAntigravityProcesses } from '../platform.mjs';
import { resignAppBundle } from '../codesign.mjs';
import { getLatestRelease } from '../net.mjs';
import { compareVersions, normalizeVersionTag } from '../version.mjs';
import { getCapsuleStatus, updateCapsuleFromUpstream } from '../modules/capsule.mjs';
import {
  getLocalizationStatus,
  installLocalization,
  UPSTREAM_REPO as L10N_REPO
} from '../modules/localization.mjs';
import { ensureWindowsProxyAssets } from '../modules/proxy.mjs';

const CAPSULE_REPO = 'Lumidarin/agy-capsule';
const PROXY_REPO = 'yuaotian/antigravity-proxy';

function sameVersion(left, right) {
  const a = normalizeVersionTag(left);
  const b = normalizeVersionTag(right);
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
    .sort((a, b) => compareVersions(a, b) ?? a.localeCompare(b, 'en', { numeric: true }));

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
  const cmp = compareVersions(localVersion, upstreamTag);
  if (cmp !== null) return cmp >= 0 ? c.green('已是最新') : c.yellow('可更新');
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
  if (failures.some(failure => /403|rate limit/i.test(failure.message))) {
    warn('GitHub API 可能被限流，可设置 GITHUB_TOKEN 后重试。');
  }

  if (!opts.apply) {
    info('使用 `agy-aio update --apply` 更新组件。');
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
      if (result.alreadyLatest) {
        info(`[dry-run] agy-capsule 已是最新版本 (${result.currentVersion || result.tag})，无需更新。`);
      } else {
        info(`[dry-run] 将把 agy-capsule 更新到 ${result.tag || '上游最新版'}（当前 ${result.currentVersion || '未知'}）。`);
      }
    } else if (result && result.alreadyLatest) {
      ok(`agy-capsule 已是最新版本 (${result.currentVersion || result.tag})，无需更新。`);
    } else {
      ok(`agy-capsule 已更新${result && result.tag ? ` 到 ${result.tag}` : ''}。`);
    }
  } catch (error) {
    applyFailed = true;
    fail(`agy-capsule 更新失败: ${error && error.message ? error.message : error}`);
  }

  if (localState.localization.found) {
    const clientVer = localState.localization.local;
    const upstreamL10n = latest.localization;

    if (opts.dryRun) {
      info(
        `[dry-run] 将检查并应用与客户端 ${clientVer || '未知'} 匹配的在线中文汉化（上游最新 ${upstreamL10n || '未知'}）。`
      );
    } else if (!upstreamL10n) {
      warn('未能获取上游中文本地化版本，已跳过汉化更新。');
    } else if (
      localState.localization.localized &&
      clientVer &&
      compareVersions(clientVer, upstreamL10n) >= 0
    ) {
      ok(`中文本地化已是最新匹配版本 (${clientVer})，无需重复应用。`);
    } else if (clientVer && normalizeVersionTag(clientVer) !== normalizeVersionTag(upstreamL10n)) {
      warn(
        `上游最新汉化 (${upstreamL10n}) 与客户端版本 (${clientVer}) 不一致，已跳过汉化更新以防白屏。`
      );
    } else {
      try {
        let canApplyL10n = true;
        if (isAntigravityRunning()) {
          const proceed = await confirm(
            '更新中文汉化需要关闭正在运行的 Antigravity。是否立即关闭？',
            { yes: Boolean(opts.yes) }
          );
          if (!proceed) {
            canApplyL10n = false;
            warn('已跳过中文本地化更新：请手动退出 Antigravity 后重试。');
          } else {
            info('正在关闭 Antigravity…');
            const stopped = await stopAntigravityProcesses({ timeoutMs: 5000 });
            if (!stopped || isAntigravityRunning()) {
              canApplyL10n = false;
              warn('Antigravity 仍在运行，已跳过中文本地化更新。');
            }
          }
        }

        if (canApplyL10n) {
          const l10nResult = await installLocalization({
            appDir: opts.appDir,
            mode: 'online',
            platformInfo,
            installations
          });
          if (platformInfo.os === 'darwin' && l10nResult.needsResign && l10nResult.appBundlePath) {
            resignAppBundle(l10nResult.appBundlePath);
          }
          ok(`中文本地化已更新（客户端 ${l10nResult.clientVersion || '未知'} / 补丁 ${l10nResult.patchVersion || upstreamL10n}）。`);
        }
      } catch (error) {
        applyFailed = true;
        fail(`中文本地化更新失败: ${error && error.message ? error.message : error}`);
      }
    }
  }

  if (platformInfo.os === 'win32') {
    try {
      const assets = await ensureWindowsProxyAssets({
        dryRun: Boolean(opts.dryRun),
        platformInfo
      });
      if (assets && assets.dryRun) {
        info(`[dry-run] 将缓存 Windows 代理资产 ${assets.tag || ''} (${assets.arch || platformInfo.arch})。`);
      } else if (assets && assets.cached) {
        ok(`Windows 代理资产已是最新缓存 (${assets.tag})。`);
      } else {
        ok(`Windows 代理资产已更新并缓存${assets && assets.tag ? ` (${assets.tag})` : ''}。`);
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
