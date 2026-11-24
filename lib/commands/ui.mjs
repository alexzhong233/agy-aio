// `agy-aio ui` — 启动仅绑定本机回环的 Web 控制面板，并在浏览器中打开。
// Node 内置模块即可，无 npm 依赖。

import { spawn } from 'node:child_process';

import { startUiServer } from '../ui-server/server.mjs';
import { banner, info, ok, warn } from '../ui.mjs';

function openBrowser(url) {
  const platform = process.platform;
  const [command, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];

  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    // 浏览器可能不存在或没有默认程序；忽略异步错误即可，控制面板本身不受影响。
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function runUi(opts = {}) {
  const { server, url, port, close } = await startUiServer({
    port: opts.port ?? 3399,
    strictPort: opts.port !== undefined,
    appDir: opts.appDir || '',
    pluginsDir: opts.pluginsDir,
    env: opts.env || process.env
  });

  banner('agy-aio 控制面板', '透明代理 · 中文汉化 · agy-capsule');
  ok(`控制面板已启动：${url}`);
  info(`监听端口：${port}（仅 127.0.0.1）`);
  info('关闭方式：按 Ctrl+C，或点击页面右上角「关闭控制面板」。');

  if (!opts.noOpen) {
    if (!openBrowser(url)) {
      warn(`无法自动打开浏览器，请手动访问 ${url}`);
    }
  }

  await new Promise(resolve => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      resolve();
    };

    const onSignal = () => {
      info('正在关闭控制面板…');
      close().finally(finish);
    };

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    server.once('close', finish);
  });

  info('控制面板已关闭。');
}
