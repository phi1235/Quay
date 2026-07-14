/**
 * Notify user when a newer npm version is available.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function packageMeta() {
  try {
    return require('../package.json');
  } catch {
    return { name: '@phi1235/quay', version: '0.0.0' };
  }
}

/**
 * Non-blocking check (best-effort). Call without await on start if desired.
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function checkForUpdate(opts = {}) {
  if (process.env.QUAY_NO_UPDATE === '1') return null;
  const meta = packageMeta();
  const name = meta.name || '@phi1235/quay';
  const current = meta.version || '0.0.0';
  const timeoutMs = opts.timeoutMs ?? 3500;

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    // scoped: /@scope%2Fname/latest
    const regName = name.startsWith('@')
      ? name.replace('/', '%2F')
      : encodeURIComponent(name);
    const res = await fetch(`https://registry.npmjs.org/${regName}/latest`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    const latest = data.version;
    if (!latest || latest === current) return { current, latest, update: false };
    if (!isNewer(latest, current)) return { current, latest, update: false };
    return { current, latest, update: true, name };
  } catch {
    return null;
  }
}

export function printUpdateNotice(info) {
  if (!info?.update) return;
  console.log('');
  console.log(`⚠  Quay update available: v${info.current} → v${info.latest}`);
  console.log(`   npm i -g ${info.name}@latest`);
  console.log('');
}

/** semver-ish a > b */
function isNewer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}
