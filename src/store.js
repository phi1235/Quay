import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

/**
 * Data dir:
 * - QUAY_DATA_DIR / CLG_DATA_DIR if set
 * - ./data when running from git clone (not inside node_modules)
 * - ~/.quay when installed via npm (-g or local node_modules)
 */
function resolveDataDir() {
  const env = process.env.QUAY_DATA_DIR || process.env.CLG_DATA_DIR;
  if (env) return path.resolve(env);
  const inNodeModules = ROOT.includes(`${path.sep}node_modules${path.sep}`);
  if (!inNodeModules) {
    const local = path.join(ROOT, 'data');
    // keep existing clone data; create on first use via ensureDataDir
    return local;
  }
  return path.join(os.homedir(), '.quay');
}

export const DATA_DIR = resolveDataDir();

const STATE_FILE = path.join(DATA_DIR, 'state.json');

/** @typedef {{
 *  id: string,
 *  provider: 'codex' | 'grok',
 *  email: string,
 *  accessToken: string,
 *  refreshToken?: string | null,
 *  accountId: string | null,
 *  userId: string | null,
 *  planType: string | null,
 *  expiresAt: string | null,
 *  enabled: boolean,
 *  createdAt: string,
 *  lastUsedAt: string | null,
 *  lastError: string | null,
 *  source: string | null,
 *  oidcClientId?: string | null,
 *  oidcIssuer?: string | null,
 *  teamId?: string | null,
 *  authMode?: string | null,
 *  quota?: any,
 *  quotaUpdatedAt?: string | null,
 *  quotaError?: string | null,
 *  cooldownUntil?: number | null,
 * }} Account */

/** @typedef {{
 *  version: number,
 *  localApiKey: string,
 *  host: string,
 *  port: number,
 *  routing: 'round_robin' | 'random' | 'first' | 'sticky',
 *  rrIndex: number,
 *  accounts: Account[],
 *  poolAccountIds: string[],
 *  pinnedByProvider?: { codex?: string | null, grok?: string | null },
 * }} State */

/** @type {State | null} */
let memoryState = null;
let dirty = false;
let saveTimer = null;
const SAVE_DEBOUNCE_MS = 500;

/** sticky conversationId -> accountId */
const stickyMap = new Map();

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function defaultState() {
  /** @type {State} */
  return {
    version: 1,
    localApiKey: `quay_${crypto.randomBytes(24).toString('base64url')}`,
    host: '127.0.0.1',
    port: 43690,
    routing: 'sticky',
    rrIndex: 0,
    accounts: [],
    poolAccountIds: [],
    pinnedByProvider: { codex: null, grok: null },
  };
}

function flushSave() {
  if (!memoryState || !dirty) return;
  ensureDataDir();
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(memoryState, null, 2));
  fs.renameSync(tmp, STATE_FILE);
  dirty = false;
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      flushSave();
    } catch (err) {
      console.error('[store] save failed', err);
    }
  }, SAVE_DEBOUNCE_MS);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

/** force immediate disk write (admin ops) */
export function saveStateNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  dirty = true;
  flushSave();
}

/** @returns {State} */
export function loadState() {
  if (memoryState) return memoryState;
  ensureDataDir();
  if (!fs.existsSync(STATE_FILE)) {
    memoryState = defaultState();
    dirty = true;
    flushSave();
    return memoryState;
  }
  const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const accounts = (Array.isArray(raw.accounts) ? raw.accounts : []).map((a) => ({
    ...a,
    provider: a.provider === 'grok' ? 'grok' : 'codex',
  }));
  const pinned = raw.pinnedByProvider && typeof raw.pinnedByProvider === 'object'
    ? {
        codex: raw.pinnedByProvider.codex || null,
        grok: raw.pinnedByProvider.grok || null,
      }
    : { codex: null, grok: null };
  memoryState = {
    ...defaultState(),
    ...raw,
    accounts,
    poolAccountIds: Array.isArray(raw.poolAccountIds) ? raw.poolAccountIds : [],
    pinnedByProvider: pinned,
  };
  return memoryState;
}

/** @param {State} state */
export function saveState(state) {
  memoryState = state;
  scheduleSave();
}

export function regenerateLocalApiKey() {
  const state = loadState();
  state.localApiKey = `quay_${crypto.randomBytes(24).toString('base64url')}`;
  saveStateNow();
  return state.localApiKey;
}

/**
 * @param {Partial<Account> & { accessToken: string }} input
 */
export function upsertAccount(input) {
  const state = loadState();
  const accessToken = String(input.accessToken || '').trim();
  if (!accessToken) throw new Error('accessToken is required');

  const provider = input.provider === 'grok' ? 'grok' : 'codex';

  const email =
    String(input.email || '').trim() ||
    guessEmailFromJwt(accessToken) ||
    `${provider}-${fingerprint(accessToken)}`;

  const accountId =
    String(input.accountId || '').trim() ||
    (provider === 'codex' ? guessAccountIdFromJwt(accessToken) : null) ||
    null;

  const userId = input.userId ?? guessUserIdFromJwt(accessToken);

  const existing =
    state.accounts.find((a) => {
      const ap = a.provider === 'grok' ? 'grok' : 'codex';
      if (ap !== provider) return false;
      if (a.accessToken === accessToken) return true;
      if (userId && a.userId && a.userId === userId) return true;
      if (accountId && a.accountId && a.accountId === accountId) return true;
      if (a.email === email) return true;
      return false;
    }) || null;

  const now = new Date().toISOString();
  if (existing) {
    existing.provider = provider;
    existing.accessToken = accessToken;
    existing.refreshToken = input.refreshToken ?? existing.refreshToken ?? null;
    existing.email = email;
    existing.accountId = accountId || existing.accountId;
    existing.userId = userId ?? existing.userId;
    existing.planType =
      input.planType != null ? String(input.planType) : existing.planType;
    existing.expiresAt = input.expiresAt ?? existing.expiresAt ?? jwtExpIso(accessToken);
    existing.enabled = input.enabled ?? existing.enabled;
    existing.source = input.source ?? existing.source;
    existing.oidcClientId = input.oidcClientId ?? existing.oidcClientId ?? null;
    existing.oidcIssuer = input.oidcIssuer ?? existing.oidcIssuer ?? null;
    existing.teamId = input.teamId ?? existing.teamId ?? null;
    existing.authMode = input.authMode ?? existing.authMode ?? null;
    existing.lastError = null;
    existing.cooldownUntil = null;
    saveStateNow();
    return existing;
  }

  /** @type {Account} */
  const account = {
    id: `acc_${crypto.randomBytes(8).toString('hex')}`,
    provider,
    email,
    accessToken,
    refreshToken: input.refreshToken ?? null,
    accountId,
    userId: userId ?? null,
    planType: String(
      input.planType ??
        (provider === 'grok' ? 'grok' : guessPlanFromJwt(accessToken) || 'unknown'),
    ),
    expiresAt: input.expiresAt ?? jwtExpIso(accessToken),
    enabled: input.enabled ?? true,
    createdAt: now,
    lastUsedAt: null,
    lastError: null,
    source: input.source ?? null,
    oidcClientId: input.oidcClientId ?? null,
    oidcIssuer: input.oidcIssuer ?? null,
    teamId: input.teamId ?? null,
    authMode: input.authMode ?? null,
    cooldownUntil: null,
  };
  state.accounts.push(account);
  saveStateNow();
  return account;
}

/** @param {string} accountId */
export function addToPool(accountId) {
  const state = loadState();
  const acc = state.accounts.find((a) => a.id === accountId);
  if (!acc) throw new Error(`Account not found: ${accountId}`);
  if (!state.poolAccountIds.includes(accountId)) {
    state.poolAccountIds.push(accountId);
    saveStateNow();
  }
  return state;
}

/** @param {string} accountId */
export function removeFromPool(accountId) {
  const state = loadState();
  state.poolAccountIds = state.poolAccountIds.filter((id) => id !== accountId);
  clearPinIfMatch(state, accountId);
  saveStateNow();
  return state;
}

/**
 * Pin account as preferred for its provider (first / sticky fallback).
 * Tự thêm vào pool nếu chưa có. Mỗi provider chỉ 1 pin.
 * @param {string} accountId
 * @param {boolean} [pin=true]
 */
export function setAccountPin(accountId, pin = true) {
  const state = loadState();
  const acc = state.accounts.find((a) => a.id === accountId);
  if (!acc) throw new Error(`Account not found: ${accountId}`);
  const provider = acc.provider === 'grok' ? 'grok' : 'codex';
  if (!state.pinnedByProvider) state.pinnedByProvider = { codex: null, grok: null };

  if (!pin) {
    if (state.pinnedByProvider[provider] === accountId) {
      state.pinnedByProvider[provider] = null;
    }
    saveStateNow();
    return state;
  }

  if (!state.poolAccountIds.includes(accountId)) {
    state.poolAccountIds.push(accountId);
  }
  // Đưa lên đầu pool (thứ tự list + first fallback)
  state.poolAccountIds = [
    accountId,
    ...state.poolAccountIds.filter((id) => id !== accountId),
  ];
  state.pinnedByProvider[provider] = accountId;
  saveStateNow();
  return state;
}

/** @param {State} state @param {string} accountId */
function clearPinIfMatch(state, accountId) {
  if (!state.pinnedByProvider) return;
  for (const p of /** @type {const} */ (['codex', 'grok'])) {
    if (state.pinnedByProvider[p] === accountId) state.pinnedByProvider[p] = null;
  }
}

/** @returns {Account[]} */
export function listPoolAccounts() {
  const state = loadState();
  const now = Date.now();
  return state.poolAccountIds
    .map((id) => state.accounts.find((a) => a.id === id))
    .filter(Boolean)
    .filter((a) => a.enabled)
    .filter((a) => !isExpired(a))
    .filter((a) => !a.cooldownUntil || a.cooldownUntil <= now);
}

/**
 * @param {{ stickyKey?: string | null, excludeIds?: Set<string>, provider?: 'codex' | 'grok' | null }} [opts]
 * @returns {Account | null}
 */
export function pickAccount(opts = {}) {
  const exclude = opts.excludeIds || new Set();
  let pool = listPoolAccounts().filter((a) => !exclude.has(a.id));
  if (opts.provider) {
    pool = pool.filter((a) => (a.provider || 'codex') === opts.provider);
  }
  if (pool.length === 0) return null;

  const state = loadState();
  const stickyKey = opts.stickyKey ? String(opts.stickyKey) : null;

  // sticky: keep same account for a conversation/session
  if ((state.routing === 'sticky' || stickyKey) && stickyKey) {
    const bound = stickyMap.get(stickyKey);
    if (bound) {
      const hit = pool.find((a) => a.id === bound);
      if (hit) return hit;
      stickyMap.delete(stickyKey);
    }
  }

  let account;
  if (state.routing === 'random') {
    account = pool[Math.floor(Math.random() * pool.length)];
  } else if (state.routing === 'first' || state.routing === 'sticky') {
    // pin (theo provider) → else đầu pool
    account = pickPinnedOrFirst(pool, state, opts.provider);
  } else {
    // round_robin — memory only, flush debounced
    const idx = state.rrIndex % pool.length;
    account = pool[idx];
    state.rrIndex = (state.rrIndex + 1) % 1_000_000_000;
    scheduleSave();
  }

  if (stickyKey && account) stickyMap.set(stickyKey, account.id);
  return account;
}

/**
 * @param {Account[]} pool
 * @param {State} state
 * @param {string | null | undefined} provider
 */
function pickPinnedOrFirst(pool, state, provider) {
  const prov =
    provider === 'grok' || provider === 'codex'
      ? provider
      : pool[0]?.provider === 'grok'
        ? 'grok'
        : 'codex';
  const pinnedId = state.pinnedByProvider?.[prov];
  if (pinnedId) {
    const hit = pool.find((a) => a.id === pinnedId);
    if (hit) return hit;
  }
  return pool[0];
}

/** hot path: update lastUsed without forcing immediate disk write */
export function touchAccount(id, patch = {}) {
  const state = loadState();
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) return null;
  Object.assign(acc, patch);
  if (!patch.lastUsedAt) acc.lastUsedAt = new Date().toISOString();
  scheduleSave();
  return acc;
}

/**
 * Temporarily skip account after auth/rate errors (default 2 min)
 * @param {string} id
 * @param {string} error
 * @param {number} [ms]
 */
export function cooldownAccount(id, error, ms = 120_000) {
  const state = loadState();
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) return;
  acc.lastError = error;
  acc.cooldownUntil = Date.now() + ms;
  scheduleSave();
}

/** @param {string} id @param {Partial<Account>} patch */
export function patchAccount(id, patch) {
  const state = loadState();
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) throw new Error(`Account not found: ${id}`);
  Object.assign(acc, patch);
  saveStateNow();
  return acc;
}

/** @param {string} accountId */
export function deleteAccount(accountId) {
  const state = loadState();
  const before = state.accounts.length;
  state.accounts = state.accounts.filter((a) => a.id !== accountId);
  state.poolAccountIds = state.poolAccountIds.filter((id) => id !== accountId);
  if (state.accounts.length === before) throw new Error(`Account not found: ${accountId}`);
  clearPinIfMatch(state, accountId);
  for (const [k, v] of stickyMap) {
    if (v === accountId) stickyMap.delete(k);
  }
  saveStateNow();
  return state;
}

/** @param {'round_robin'|'random'|'first'|'sticky'} routing */
export function setRouting(routing) {
  const state = loadState();
  if (!['round_robin', 'random', 'first', 'sticky'].includes(routing)) {
    throw new Error('routing must be round_robin | random | first | sticky');
  }
  state.routing = routing;
  saveStateNow();
  return state;
}

/** @param {number} port */
export function setPort(port) {
  const state = loadState();
  const n = Number(port);
  if (!Number.isFinite(n) || n < 1 || n > 65535) throw new Error('Invalid port');
  state.port = n;
  saveStateNow();
  return state;
}

/**
 * @param {Account} a
 * @param {string[]} poolIds
 */
export function publicAccount(a, poolIds) {
  const token = a.accessToken || '';
  const now = Date.now();
  const provider = a.provider === 'grok' ? 'grok' : 'codex';
  const state = loadState();
  const pinnedId = state.pinnedByProvider?.[provider] || null;
  return {
    id: a.id,
    provider,
    email: a.email,
    accountId: a.accountId,
    userId: a.userId,
    planType: a.planType,
    expiresAt: a.expiresAt,
    enabled: a.enabled,
    createdAt: a.createdAt,
    lastUsedAt: a.lastUsedAt,
    lastError: a.lastError,
    source: a.source,
    teamId: a.teamId || null,
    authMode: a.authMode || null,
    inPool: poolIds.includes(a.id),
    pinned: pinnedId === a.id,
    expired: isExpired(a),
    coolingDown: Boolean(a.cooldownUntil && a.cooldownUntil > now),
    cooldownUntil: a.cooldownUntil || null,
    tokenPreview: token
      ? `${token.slice(0, 12)}…${token.slice(-8)} (len=${token.length})`
      : null,
    quota: a.quota || null,
    quotaUpdatedAt: a.quotaUpdatedAt || null,
    quotaError: a.quotaError || null,
  };
}

export function publicStatus() {
  const state = loadState();
  const accounts = state.accounts.map((a) => publicAccount(a, state.poolAccountIds));
  const pool = listPoolAccounts();
  return {
    host: state.host,
    port: state.port,
    localApiKey: state.localApiKey,
    routing: state.routing,
    accountsTotal: state.accounts.length,
    poolSize: state.poolAccountIds.length,
    poolCodex: pool.filter((a) => (a.provider || 'codex') === 'codex').length,
    poolGrok: pool.filter((a) => a.provider === 'grok').length,
    baseUrl: `http://${state.host}:${state.port}/v1`,
    uiUrl: `http://${state.host}:${state.port}/`,
    dataDir: DATA_DIR,
    running: true,
    accounts,
    poolAccountIds: state.poolAccountIds,
  };
}

/**
 * @param {string} id
 * @param {any} quota
 */
export function saveAccountQuota(id, quota) {
  const state = loadState();
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) throw new Error(`Account not found: ${id}`);
  acc.quota = quota;
  acc.quotaUpdatedAt = new Date().toISOString();
  acc.quotaError = null;
  if (quota?.planType) acc.planType = quota.planType;
  if (quota?.email && (!acc.email || acc.email.startsWith('codex-'))) {
    acc.email = quota.email;
  }
  saveStateNow();
  return acc;
}

/**
 * @param {string} id
 * @param {string} error
 */
export function saveAccountQuotaError(id, error) {
  const state = loadState();
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) throw new Error(`Account not found: ${id}`);
  acc.quotaError = error;
  acc.quotaUpdatedAt = new Date().toISOString();
  saveStateNow();
  return acc;
}

function fingerprint(token) {
  return crypto.createHash('md5').update(token).digest('hex').slice(0, 10);
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = '='.repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(payload + pad, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function guessEmailFromJwt(token) {
  const p = decodeJwtPayload(token);
  if (!p) return null;
  const profile = p['https://api.openai.com/profile'];
  if (profile && typeof profile === 'object' && profile.email) return String(profile.email);
  return p.email || p.preferred_username || null;
}

function guessAccountIdFromJwt(token) {
  const p = decodeJwtPayload(token);
  if (!p) return null;
  const auth = p['https://api.openai.com/auth'];
  if (auth && typeof auth === 'object') {
    return auth.chatgpt_account_id || auth.account_id || null;
  }
  return null;
}

function guessUserIdFromJwt(token) {
  const p = decodeJwtPayload(token);
  if (!p) return null;
  const auth = p['https://api.openai.com/auth'];
  if (auth && typeof auth === 'object') {
    return auth.chatgpt_user_id || auth.user_id || null;
  }
  return p.sub || null;
}

function guessPlanFromJwt(token) {
  const p = decodeJwtPayload(token);
  if (!p) return null;
  const auth = p['https://api.openai.com/auth'];
  if (auth && typeof auth === 'object') return auth.chatgpt_plan_type || null;
  return null;
}

function jwtExpIso(token) {
  const p = decodeJwtPayload(token);
  if (!p || !p.exp) return null;
  return new Date(Number(p.exp) * 1000).toISOString();
}

/** @param {Account} account */
export function isExpired(account) {
  // Grok OIDC can refresh — only "expired" when access dead AND no refresh
  if (account.provider === 'grok' && account.refreshToken) {
    return false;
  }
  if (!account.expiresAt) {
    const exp = jwtExpIso(account.accessToken);
    if (!exp) return false;
    return Date.now() >= new Date(exp).getTime();
  }
  return Date.now() >= new Date(account.expiresAt).getTime();
}
