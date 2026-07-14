/**
 * Import Grok accounts from `grok login` (~/.grok/auth.json) and multi-account vault.
 *
 * Multi-account flow:
 *   1) grok login  (account A)
 *   2) quay import-grok  / UI "+ Grok"  → lưu A vào vault + pool
 *   3) grok login  (account B)  — ghi đè auth.json, A vẫn trong vault
 *   4) quay import-grok lại → vault = A + B
 *
 * Cũng nhận dán JSON: auth.json map, mảng entry, hoặc 1 entry phẳng.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { upsertAccount, DATA_DIR } from './store.js';

export function defaultGrokAuthPath() {
  return process.env.GROK_HOME
    ? path.join(process.env.GROK_HOME, 'auth.json')
    : path.join(os.homedir(), '.grok', 'auth.json');
}

function vaultPath() {
  return path.join(DATA_DIR, 'grok-vault.json');
}

function loadVault() {
  const file = vaultPath();
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function saveVault(vault) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${vaultPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(vault, null, 2));
  fs.renameSync(tmp, vaultPath());
}

/**
 * Normalize any Grok auth shape → list of credential entries.
 * @param {any} raw
 * @returns {object[]}
 */
export function extractGrokEntries(raw) {
  /** @type {object[]} */
  const out = [];

  const pushEntry = (entry, mapKey = '') => {
    if (!entry || typeof entry !== 'object') return;
    const token = String(
      entry.key || entry.access_token || entry.accessToken || '',
    ).trim();
    if (!token) return;
    // prefer OIDC-ish; still accept bare JWT if looks like access token
    out.push({ ...entry, __mapKey: mapKey });
  };

  if (!raw) return out;

  if (Array.isArray(raw)) {
    for (const item of raw) pushEntry(item);
    return out;
  }

  if (typeof raw !== 'object') return out;

  // Single flat credential
  if (raw.key || raw.access_token || raw.accessToken) {
    if (raw.auth_mode === 'oidc' || raw.refresh_token || raw.refreshToken || raw.user_id) {
      pushEntry(raw);
      return out;
    }
    // bare token object
    if (raw.key || raw.access_token) {
      pushEntry(raw);
      return out;
    }
  }

  // auth.json map: { "https://auth.x.ai::client": { key, refresh_token, ... } }
  for (const [mapKey, entry] of Object.entries(raw)) {
    if (mapKey === 'accounts' && Array.isArray(entry)) {
      for (const item of entry) pushEntry(item);
      continue;
    }
    pushEntry(entry, mapKey);
  }

  return out;
}

export function looksLikeGrokAuth(raw) {
  const entries = extractGrokEntries(raw);
  if (!entries.length) return false;
  return entries.some(
    (e) =>
      e.auth_mode === 'oidc' ||
      e.refresh_token ||
      e.refreshToken ||
      e.oidc_client_id ||
      e.oidcClientId ||
      (typeof e.key === 'string' && e.key.startsWith('eyJ') && (e.email || e.user_id)),
  );
}

/**
 * @param {object} entry
 * @param {string} [source]
 */
function upsertFromEntry(entry, source = 'grok-login') {
  const token = String(entry.key || entry.access_token || entry.accessToken || '').trim();
  const mapKey = entry.__mapKey || '';
  const email =
    String(entry.email || '').trim() ||
    `grok-${String(entry.user_id || entry.principal_id || mapKey || token).slice(0, 12)}`;

  const expiresAt =
    entry.expires_at ||
    entry.expiresAt ||
    (typeof entry.expires_in === 'number'
      ? new Date(Date.now() + entry.expires_in * 1000).toISOString()
      : null);

  const userId = entry.user_id || entry.principal_id || entry.userId || null;

  return upsertAccount({
    provider: 'grok',
    accessToken: token,
    refreshToken: entry.refresh_token || entry.refreshToken || null,
    email,
    userId,
    accountId: entry.team_id || entry.teamId || null,
    planType: String(
      entry.subscription_tier ?? entry.tier ?? entry.planType ?? 'grok',
    ),
    expiresAt,
    source,
    oidcClientId: entry.oidc_client_id || entry.oidcClientId || null,
    oidcIssuer: entry.oidc_issuer || entry.oidcIssuer || 'https://auth.x.ai',
    teamId: entry.team_id || entry.teamId || null,
    authMode: entry.auth_mode || entry.authMode || 'oidc',
  });
}

/**
 * Merge entries into persistent multi-account vault (keyed by user_id / email).
 * @param {object[]} entries
 */
export function mergeIntoVault(entries) {
  const vault = loadVault();
  let added = 0;
  for (const entry of entries) {
    const token = String(entry.key || entry.access_token || entry.accessToken || '').trim();
    if (!token) continue;
    const id =
      entry.user_id ||
      entry.principal_id ||
      entry.userId ||
      entry.email ||
      `tok_${token.slice(-12)}`;
    const key = String(id);
    const prev = vault[key];
    vault[key] = {
      ...(prev || {}),
      ...entry,
      key: token,
      refresh_token: entry.refresh_token || entry.refreshToken || prev?.refresh_token || null,
      email: entry.email || prev?.email,
      user_id: entry.user_id || entry.principal_id || entry.userId || prev?.user_id,
      oidc_client_id: entry.oidc_client_id || entry.oidcClientId || prev?.oidc_client_id,
      oidc_issuer: entry.oidc_issuer || entry.oidcIssuer || prev?.oidc_issuer || 'https://auth.x.ai',
      expires_at: entry.expires_at || entry.expiresAt || prev?.expires_at,
      team_id: entry.team_id || entry.teamId || prev?.team_id,
      auth_mode: entry.auth_mode || entry.authMode || prev?.auth_mode || 'oidc',
      updatedAt: new Date().toISOString(),
    };
    // strip internal
    delete vault[key].__mapKey;
    if (!prev) added += 1;
  }
  saveVault(vault);
  return { vault, added, total: Object.keys(vault).length };
}

/**
 * Upsert every vault entry into account store.
 */
export function importFromVault() {
  const vault = loadVault();
  const entries = Object.values(vault);
  /** @type {ReturnType<typeof upsertAccount>[]} */
  const imported = [];
  for (const entry of entries) {
    imported.push(upsertFromEntry(entry, 'grok-vault'));
  }
  return imported;
}

/**
 * Import current `grok login` auth.json → merge vault → load all vault accounts.
 * @param {string} [authPath]
 */
export function importGrokLogin(authPath) {
  const file = authPath || defaultGrokAuthPath();
  if (!fs.existsSync(file)) {
    // still allow reloading vault only
    const fromVault = importFromVault();
    if (fromVault.length) return fromVault;
    throw new Error(
      `Không thấy ${file}. Chạy \`grok login\` trước, hoặc dán auth.json vào Thêm JSON.`,
    );
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`Không đọc được JSON: ${file}`);
  }

  const entries = extractGrokEntries(raw);
  if (!entries.length) {
    const fromVault = importFromVault();
    if (fromVault.length) return fromVault;
    throw new Error(
      'Không có credential Grok trong auth.json. Chạy `grok login` rồi thử lại.',
    );
  }

  mergeIntoVault(entries);
  // Re-import entire vault so previous accounts stay
  const all = importFromVault();
  if (!all.length) {
    throw new Error('Import Grok thất bại (vault trống).');
  }
  return all;
}

/**
 * Import from pasted JSON text (auth map / array / single entry).
 * @param {string} text
 */
export function importGrokFromText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Thiếu JSON Grok');
  let raw;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    throw new Error('JSON Grok không hợp lệ');
  }
  const entries = extractGrokEntries(raw);
  if (!entries.length) {
    throw new Error('Không tìm thấy credential Grok trong JSON');
  }
  mergeIntoVault(entries);
  return importFromVault();
}

export function vaultStats() {
  const vault = loadVault();
  return {
    path: vaultPath(),
    count: Object.keys(vault).length,
    emails: Object.values(vault).map((e) => e.email || e.user_id || '?'),
  };
}
