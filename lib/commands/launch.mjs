// `agy-aio launch` — start Antigravity with CDP enabled.

import { c, section, info, ok, table } from '../ui.mjs';
import { getPlatformInfo, detectInstallations } from '../platform.mjs';
import { launchAntigravity } from '../launcher.mjs';

function formatCommand(command, args = []) {
  const parts = [command, ...args].filter(part => part !== undefined && part !== null && part !== '');
  return parts
    .map(part => {
      const value = String(part);
      return /\s/.test(value) ? JSON.stringify(value) : value;
    })
    .join(' ');
}

export async function runLaunch(opts = {}) {
  const platformInfo = getPlatformInfo();
  const installations = detectInstallations({ appDir: opts.appDir, platformInfo });

  const result = launchAntigravity({
    dryRun: Boolean(opts.dryRun),
    appDir: opts.appDir,
    platformInfo,
    installations
  });

  if (!result || !result.supported) {
    throw new Error(
      `当前平台暂不支持 launch${result && result.reason ? ` (${result.reason})` : ''}。`
    );
  }

  if (result.reason === 'antigravity-not-found') {
    throw new Error('未找到 Antigravity 安装，请先安装客户端或使用 --app-dir 指定安装路径。');
  }

  section('启动 Antigravity');
  const command = formatCommand(result.command, result.args);

  if (result.dryRun) {
    info(`[dry-run] 将执行: ${c.bold(command)}`);
    return result;
  }

  if (!result.launched) {
    throw new Error(`启动失败: ${result.reason || '无法创建 Antigravity 进程'}`);
  }

  table(
    [
      ['命令', command],
      ['PID', result.pid != null ? String(result.pid) : '(detached)']
    ],
    ['项目', '值']
  );
  ok('Antigravity 已启动（已附加 CDP 调试端口）。');
  info('如状态异常，请先退出客户端后重新运行 `agy-aio launch`。');

  return result;
}
