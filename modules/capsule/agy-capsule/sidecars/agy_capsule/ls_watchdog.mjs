import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { loopbackFetch } from './loopback_fetch.mjs';

const exec = promisify(execFile);
const procOptions = { encoding: 'utf8', timeout: 3000, windowsHide: true, maxBuffer: 32 * 1024 };
const lsName = /^language_server(?:_[a-z0-9_-]+)?(?:\.exe)?$/i;

// Read the actual launch chain, not the latest hub file or current port owner.
// Stop at a reused parent PID; birth values are comparable only on the same OS.
async function processRows(pid, ancestors) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return [];
  const limit = ancestors ? 6 : 1;
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop'; $n=${pid};
      for($i=0; $i -lt ${limit} -and $n -gt 0; $i++){
        $p=Get-Process -Id $n -ErrorAction SilentlyContinue; if(!$p){break}
        $birth=$p.StartTime.ToFileTimeUtc(); if(!$birth){break}
        Write-Output ("{0}|{1}|{2}" -f $n,$birth,$p.ProcessName)
        if($i+1 -ge ${limit} -or $p.ProcessName -match '^language_server($|_)'){break}
        $row=Get-CimInstance Win32_Process -Filter "ProcessId=$n" -Property ParentProcessId
        if(!$row -or $p.HasExited){break}; $n=$row.ParentProcessId
      }`;
    const shell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await exec(shell, ['-NoProfile', '-NonInteractive', '-Command', script], procOptions);
    return stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
      const [id, birth, name] = line.split('|');
      return { pid: Number(id), birth: BigInt(birth), name };
    });
  }
  const rows = [];
  while (pid > 0 && rows.length < limit) {
    let birth, name, parent, dead;
    if (process.platform === 'linux') {
      const stat = await readFile('/proc/' + pid + '/stat', 'utf8');
      const end = stat.lastIndexOf(')');
      name = stat.slice(stat.indexOf('(') + 1, end);
      const fields = stat.slice(end + 2).split(' '); // state (field 3) through starttime (22)
      parent = Number(fields[1]); birth = BigInt(fields[19]); dead = ['Z', 'X'].includes(fields[0]);
    } else if (process.platform === 'darwin') {
      const { stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', 'ppid=,lstart=,state=,comm='], {
        ...procOptions, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      });
      const match = /^\s*(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d{4})\s+(\S+)\s+(.+)$/.exec(stdout.trim());
      if (!match) break;
      parent = Number(match[1]); birth = BigInt(Date.parse(match[2] + ' GMT'));
      dead = match[3].includes('Z'); name = basename(match[4]);
    } else break;
    rows.push({ pid, birth, name, dead });
    if (dead || lsName.test(name)) break;
    pid = parent;
  }
  return rows;
}

export function createOwnerProbe({ rows = processRows, exists = pid => process.kill(pid, 0) } = {}) {
  let owner, gone = false;
  return async () => {
    if (gone) return 'gone';
    try {
      if (!owner) {
        const chain = await rows(process.pid, true);
        if (chain[0]?.pid !== process.pid) return 'unbound';
        for (let i = 1; i < chain.length; i++) {
          const row = chain[i];
          if (row.birth > chain[i - 1].birth) break;
          if (lsName.test(row.name)) {
            owner = row; gone = !!row.dead;
            console.log('[agy-capsule] watchdog bound to original language server');
            break;
          }
        }
        return gone ? 'gone' : owner ? 'alive' : 'unbound';
      }
      exists(owner.pid); // ESRCH means gone; EPERM is not evidence of death.
      const [actual] = await rows(owner.pid, false);
      if (!actual) return 'unknown';
      gone = !!actual.dead || actual.birth !== owner.birth || actual.name !== owner.name;
      return gone ? 'gone' : 'alive';
    } catch (error) {
      if (owner && error.code === 'ESRCH') {
        gone = true; return 'gone';
      }
      return owner ? 'unknown' : 'unbound';
    }
  };
}

// An AggregateError can contain IPv4 and IPv6 failures with no top-level code.
// Unknown leaf errors cannot prove loss of the server. Avoid cycling through causes.
export function connectionFailed(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  if (Array.isArray(error.errors) && error.errors.length) {
    return error.errors.every(child => connectionFailed(child, new Set(seen)));
  }
  if (error.name === 'TimeoutError' || /^(?:ECONN\w*|ENET\w*|EHOST\w*|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EADDRNOTAVAIL|ERR_SOCKET_CLOSED|UND_ERR_(?:SOCKET|CLOSED|DESTROYED|CONNECT_TIMEOUT|HEADERS_TIMEOUT))$/.test(error.code || '')) return true;
  return connectionFailed(error.cause, seen);
}

export function startLsWatchdog(address, shutdown, { fetchImpl = loopbackFetch, schedule = setInterval, cancel = clearInterval,
  now = () => performance.now(), ownerProbe = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(address) ? createOwnerProbe() : () => 'unbound' } = {}) {
  if (!address) return () => {};
  // Capture at launch, even if the owner disappears before the first interval.
  let ready = ownerProbe();
  let failures = 0, firstFailure = null, stopped = false, busy = false;
  const stop = () => { if (!stopped) { stopped = true; cancel(timer); } };
  const timer = schedule(async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      if (ready) { await ready; ready = null; }
      if (stopped) return;
      let state = await ownerProbe();
      if (state === 'unbound') {
        try {
          // No credentials; a redirect proves liveness without contacting its target.
          await fetchImpl('http://' + address + '/', { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(3000) });
          state = 'alive';
        } catch (error) {
          state = error?.cause?.message === 'unexpected redirect' ? 'alive' : connectionFailed(error) ? 'gone' : 'unknown';
        }
      }
      if (stopped) return;
      // Ambiguous evidence is not a consecutive failure. Once a pinned owner
      // has actually exited, createOwnerProbe remembers that fact permanently.
      if (state !== 'gone') { failures = 0; firstFailure = null; return; }
      const at = now(); firstFailure ??= at;
      if (++failures >= 4 && at - firstFailure >= 120_000) {
        stop(); await shutdown('language server gone');
      }
    } finally { busy = false; }
  }, 30_000);
  timer.unref();
  return stop;
}
