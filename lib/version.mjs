// Semver-like version normalization and comparison helpers. Node built-ins only.

export function normalizeVersionTag(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/^v/i, '');
}

function parseVersionParts(value) {
  const cleaned = normalizeVersionTag(value);
  if (!cleaned) return null;

  const plusIdx = cleaned.indexOf('+');
  const withoutBuild = plusIdx === -1 ? cleaned : cleaned.slice(0, plusIdx);
  const dashIdx = withoutBuild.indexOf('-');
  const coreStr = dashIdx === -1 ? withoutBuild : withoutBuild.slice(0, dashIdx);
  const preStr = dashIdx === -1 ? '' : withoutBuild.slice(dashIdx + 1);

  if (!coreStr) return null;
  const coreParts = coreStr.split('.');
  if (coreParts.some(part => !/^\d+$/.test(part))) return null;

  const core = coreParts.map(part => Number(part));
  if (core.some(num => !Number.isSafeInteger(num))) return null;

  return {
    core,
    pre: preStr ? preStr.split('.') : []
  };
}

/**
 * Compare two version strings (supporting optional leading `v`, 3- or 4-part
 * core versions like `2.34.0.1`, and prerelease tags). Returns 1, 0, -1, or
 * null if either input cannot be parsed as a numeric version.
 */
export function compareVersions(left, right) {
  const pa = parseVersionParts(left);
  const pb = parseVersionParts(right);
  if (!pa || !pb) return null;

  const maxLen = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < maxLen; i += 1) {
    const a = pa.core[i] ?? 0;
    const b = pb.core[i] ?? 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }

  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;

  const minPre = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < minPre; i += 1) {
    const xa = pa.pre[i];
    const xb = pb.pre[i];
    if (xa === xb) continue;

    const aNum = /^\d+$/.test(xa);
    const bNum = /^\d+$/.test(xb);
    if (aNum && bNum) {
      const na = Number(xa);
      const nb = Number(xb);
      if (na !== nb) return na > nb ? 1 : -1;
      continue;
    }
    if (aNum !== bNum) return aNum ? -1 : 1;
    return xa > xb ? 1 : -1;
  }

  if (pa.pre.length === pb.pre.length) return 0;
  return pa.pre.length > pb.pre.length ? 1 : -1;
}
