import { execFile } from 'node:child_process';

// sidecar_sdk runs `agentapi` with execFileSync for its built-in /_sidecar/* routes.
// The panel preload calls get-conversation-metadata on every conversation switch,
// which froze this process (and the deck injector) for ~20 s. Same commands, async.
export function runAgentApi(args, { projectId, env = process.env, execFileImpl = execFile } = {}) {
  const childEnv = { ...env };
  if (projectId) childEnv.ANTIGRAVITY_PROJECT_ID = projectId;
  const exe = env.ANTIGRAVITY_AGENTAPI_EXE;
  const file = exe || 'agentapi';
  const execArgs = exe ? ['agentapi', ...args] : args;
  return new Promise((resolve, reject) => {
    execFileImpl(file, execArgs, { encoding: 'utf-8', env: childEnv, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) { reject(err); return; }
      try {
        const out = String(stdout ?? '').trim();
        resolve(out ? JSON.parse(out) : {});
      } catch (parseErr) {
        reject(parseErr);
      }
    });
  });
}

// Call after app.run(): the SDK looks up handlers per request, so these replace its sync ones.
export function installAsyncHostRoutes(app, options = {}) {
  const run = (args, extra) => runAgentApi(args, { ...options, ...extra });
  app.api('/_sidecar/send-message', (data = {}) => {
    const args = ['send-message'];
    if (data.title) args.push('--title', data.title);
    args.push(data.conversationId, data.message);
    return run(args, { projectId: data.projectId });
  }, 'POST');
  app.api('/_sidecar/new-conversation', (data = {}) =>
    run(['new-conversation', '--model', data.model || 'flash', data.message], { projectId: data.projectId }), 'POST');
  app.api('/_sidecar/get-conversation-metadata', (data = {}) =>
    run(['get-conversation-metadata', data.conversationId]), 'POST');
}

// The host may close our stdio pipes; a stray EPIPE must not take the sidecar down
// (restart_policy: always would bring it back with the capsule blank for seconds).
export function installEpipeGuard(proc = process) {
  const isEpipe = err => err?.code === 'EPIPE';
  for (const stream of [proc.stdout, proc.stderr]) {
    stream?.on?.('error', err => { if (!isEpipe(err)) throw err; });
  }
  const fatal = err => {
    if (isEpipe(err)) return;
    try { console.error('[agy-capsule] fatal:', err); } catch {}
    proc.exit(1);
  };
  proc.on('uncaughtException', fatal);
  proc.on('unhandledRejection', fatal);
}
