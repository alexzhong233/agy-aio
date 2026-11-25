import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * Read the signature information for a binary or app bundle.
 *
 * `codesign -dvv` writes its report to stderr, so the command is run through
 * /bin/sh with `2>&1`; the target is passed as a positional argument so it is
 * never interpreted by the shell.
 *
 * @param {string} targetPath
 * @returns {'not-applicable' | 'missing' | 'google' | 'adhoc' | 'unsigned' | 'unknown'}
 */
export function checkCodesign(targetPath) {
  if (process.platform !== 'darwin') return 'not-applicable';
  if (!targetPath || !fs.existsSync(targetPath)) return 'missing';

  let output = '';
  let exitCode = 0;
  try {
    output = String(
      execFileSync('/bin/sh', ['-c', 'exec codesign -dvv "$1" 2>&1', 'codesign', targetPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }) || '',
    );
  } catch (err) {
    exitCode = typeof err?.status === 'number' ? err.status : 1;
    output = [err?.stdout, err?.stderr]
      .filter((part) => part !== undefined && part !== null && part !== '')
      .map((part) => String(part))
      .join('\n');
  }

  if (output.includes('Developer ID Application: Google LLC')) return 'google';
  if (/code object is not signed at all/i.test(output)) return 'unsigned';
  if (/Signature=adhoc/i.test(output) || /adhoc/i.test(output)) return 'adhoc';
  // codesign exits 0 for any signature it could read; without a Developer ID
  // certificate that means an ad-hoc signature.
  if (exitCode === 0) return 'adhoc';
  return 'unknown';
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isPermissionError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code === 'EPERM' || err.code === 'EACCES') return true;

  const text = [err.message, err.stderr, err.stdout]
    .filter((part) => part !== undefined && part !== null)
    .map((part) => (typeof part === 'string' ? part : String(part)))
    .join('\n');

  return /Operation not permitted/i.test(text) || /Permission denied/i.test(text);
}

function permissionFailure(action, target, cause) {
  const error = new Error(
    `Permission denied while trying to ${action} "${target}". ` +
      'Move the app to a location you own (for example ~/Applications), ' +
      'or run this command with administrator rights, then try again.',
  );
  error.isPermissionError = true;
  error.cause = cause;
  if (cause && typeof cause.code === 'string') error.code = cause.code;
  return error;
}

/**
 * Replace a binary's signature with an ad-hoc one, preserving entitlements
 * when supported by the binary's previous signature.
 *
 * @param {string} binPath
 * @param {{ dryRun?: boolean }} [options]
 * @returns {{ signed: boolean, skipped?: boolean, dryRun?: boolean, reason?: string, binPath?: string, entitlementsPreserved?: boolean }}
 */
export function signBinaryAdhoc(binPath, { dryRun = false } = {}) {
  if (process.platform !== 'darwin') return { signed: false, skipped: true };
  if (dryRun) return { signed: false, dryRun: true };
  if (!binPath || !fs.existsSync(binPath)) {
    return { signed: false, skipped: true, reason: 'missing', binPath };
  }

  try {
    execFileSync('codesign', ['-f', '-s', '-', '--preserve-metadata=entitlements', binPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return { signed: true, binPath, entitlementsPreserved: true };
  } catch (err) {
    if (isPermissionError(err)) throw permissionFailure('sign', binPath, err);
  }

  try {
    execFileSync('codesign', ['-f', '-s', '-', binPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    if (isPermissionError(err)) throw permissionFailure('sign', binPath, err);
    throw err;
  }

  return { signed: true, binPath, entitlementsPreserved: false };
}

/**
 * Strip extended attributes and re-sign an .app bundle ad-hoc while
 * preserving existing entitlements where possible.
 *
 * @param {string} appPath
 * @param {{ dryRun?: boolean }} [options]
 * @returns {{ signed: boolean, skipped?: boolean, dryRun?: boolean, reason?: string, appPath?: string, entitlementsPreserved?: boolean }}
 */
export function resignAppBundle(appPath, { dryRun = false } = {}) {
  if (process.platform !== 'darwin') return { signed: false, skipped: true };
  if (!appPath || !fs.existsSync(appPath)) return { signed: false, skipped: true };
  if (dryRun) return { signed: false, dryRun: true, appPath };

  try {
    execFileSync('xattr', ['-cr', appPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    // xattr exits non-zero when there is nothing to remove on some macOS
    // versions; only a permission problem is fatal here.
    if (isPermissionError(err)) throw permissionFailure('clear extended attributes on', appPath, err);
  }

  try {
    execFileSync(
      'codesign',
      ['--force', '--deep', '--preserve-metadata=entitlements', '--sign', '-', appPath],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    return { signed: true, appPath, entitlementsPreserved: true };
  } catch (err) {
    if (isPermissionError(err)) throw permissionFailure('re-sign', appPath, err);
  }

  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    if (isPermissionError(err)) throw permissionFailure('re-sign', appPath, err);
    throw err;
  }

  return { signed: true, appPath, entitlementsPreserved: false };
}

/**
 * Deeply verify a macOS app bundle signature strictly.
 *
 * @param {string} appPath
 * @returns {{ valid: boolean, codesign: 'not-applicable' | 'missing' | 'google' | 'adhoc' | 'unsigned' | 'unknown', detail: string }}
 */
export function verifyAppSignature(appPath) {
  if (process.platform !== 'darwin') {
    return { valid: true, codesign: 'not-applicable', detail: '' };
  }
  if (!appPath || !fs.existsSync(appPath)) {
    return { valid: false, codesign: 'missing', detail: 'App bundle does not exist.' };
  }

  let valid = false;
  let detail = '';
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    valid = true;
  } catch (err) {
    detail = [err?.stderr, err?.stdout, err?.message]
      .filter((part) => part !== undefined && part !== null && part !== '')
      .map((part) => String(part).trim())
      .join('\n');
  }

  return { valid, codesign: checkCodesign(appPath), detail };
}
