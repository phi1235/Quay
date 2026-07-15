/**
 * Import Perplexity.ai session from browser cookie export JSON.
 *
 * Accepts:
 * - Chrome/EditThisCookie array: [{ name, value, domain, ... }, ...]
 * - { cookies: [...] }
 * - { cookie / cookieHeader: "a=b; c=d" }
 * - map { "__Secure-next-auth.session-token": "...", ... }
 */

import { upsertAccount } from './store.js';

const SESSION_URL =
  process.env.QUAY_PPLX_SESSION_URL ||
  'https://www.perplexity.ai/api/auth/session';

const DEFAULT_UA =
  process.env.QUAY_PPLX_UA ||
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Cookie names we forward to Perplexity (auth + session glue). */
const KEEP_COOKIE_NAMES = new Set([
  '__Secure-next-auth.session-token',
  'next-auth.session-token',
  'pplx.session-id',
  'pplx.visitor-id',
  'pplx.edge-sid',
  'pplx.edge-vid',
  '__cflb',
  '__cf_bm',
]);

/**
 * @param {unknown} value
 */
export function looksLikePerplexityCookies(value) {
  if (!value) return false;
  if (typeof value === 'string') {
    return (
      /__Secure-next-auth\.session-token\s*=/.test(value) ||
      /perplexity\.ai/i.test(value)
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return false;
    const names = value
      .filter((c) => c && typeof c === 'object')
      .map((c) => String(/** @type {any} */ (c).name || ''));
    if (names.some((n) => n.includes('next-auth.session-token'))) return true;
    // cookie export from perplexity domains
    const domains = value
      .filter((c) => c && typeof c === 'object')
      .map((c) => String(/** @type {any} */ (c).domain || '').toLowerCase());
    return (
      domains.some((d) => d.includes('perplexity.ai')) &&
      names.some((n) => n.startsWith('pplx.') || n.includes('session'))
    );
  }
  if (typeof value === 'object') {
    const o = /** @type {Record<string, unknown>} */ (value);
    if (Array.isArray(o.cookies) && looksLikePerplexityCookies(o.cookies)) {
      return true;
    }
    if (typeof o.cookie === 'string' || typeof o.cookieHeader === 'string') {
      return looksLikePerplexityCookies(String(o.cookie || o.cookieHeader));
    }
    const keys = Object.keys(o);
    if (keys.some((k) => k.includes('next-auth.session-token'))) return true;
    if (
      keys.some((k) => k.startsWith('pplx.')) &&
      (o.provider === 'perplexity' || o.domain === 'perplexity.ai')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} text
 * @param {{ autoPool?: boolean, validate?: boolean }} [opts]
 */
export async function importPerplexityFromText(text, opts = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Empty Perplexity cookie input');

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // raw Cookie header
    if (looksLikePerplexityCookies(trimmed)) {
      parsed = { cookieHeader: trimmed };
    } else {
      throw new Error('JSON cookie export không hợp lệ');
    }
  }

  if (!looksLikePerplexityCookies(parsed)) {
    throw new Error(
      'Không nhận diện cookie Perplexity. Cần export cookie từ perplexity.ai (có __Secure-next-auth.session-token).',
    );
  }

  const cookieMap = extractCookieMap(parsed);
  const sessionToken =
    cookieMap['__Secure-next-auth.session-token'] ||
    cookieMap['next-auth.session-token'];
  if (!sessionToken) {
    throw new Error('Thiếu cookie __Secure-next-auth.session-token');
  }

  const cookieHeader = buildCookieHeader(cookieMap);
  const visitorId = cookieMap['pplx.visitor-id'] || null;
  const sessionId = cookieMap['pplx.session-id'] || null;

  /** @type {{ email?: string, userId?: string, planType?: string, expiresAt?: string, name?: string }} */
  let profile = {};
  if (opts.validate !== false) {
    profile = await fetchPerplexitySession(cookieHeader);
  }

  // dedicated pplx session cookie often named __Secure-pplx.session.<userId>
  let accountId = profile.userId || null;
  for (const name of Object.keys(cookieMap)) {
    const m = name.match(/^__Secure-pplx\.session\.(.+)$/);
    if (m) {
      accountId = accountId || m[1];
      break;
    }
  }

  const email =
    profile.email ||
    (accountId ? `pplx-${String(accountId).slice(0, 8)}` : null) ||
    `pplx-${fingerprint(sessionToken)}`;

  const account = upsertAccount({
    provider: 'perplexity',
    accessToken: cookieHeader,
    email,
    accountId: accountId || visitorId,
    userId: profile.userId || accountId,
    planType: profile.planType || 'perplexity',
    expiresAt: profile.expiresAt || null,
    source: 'perplexity-cookies',
    authMode: 'cookies',
  });

  return [account];
}

/**
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
export function extractCookieMap(value) {
  /** @type {Record<string, string>} */
  const map = {};

  if (typeof value === 'string') {
    for (const part of value.split(';')) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const name = part.slice(0, idx).trim();
      const val = part.slice(idx + 1).trim();
      if (name) map[name] = val;
    }
    return map;
  }

  if (Array.isArray(value)) {
    for (const c of value) {
      if (!c || typeof c !== 'object') continue;
      const name = String(/** @type {any} */ (c).name || '').trim();
      const val = /** @type {any} */ (c).value;
      if (!name || val == null) continue;
      if (shouldKeepCookie(name)) map[name] = String(val);
    }
    return map;
  }

  if (value && typeof value === 'object') {
    const o = /** @type {Record<string, unknown>} */ (value);
    if (Array.isArray(o.cookies)) return extractCookieMap(o.cookies);
    if (typeof o.cookie === 'string') return extractCookieMap(o.cookie);
    if (typeof o.cookieHeader === 'string') return extractCookieMap(o.cookieHeader);
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && shouldKeepCookie(k)) map[k] = v;
    }
  }
  return map;
}

/**
 * @param {string} name
 */
function shouldKeepCookie(name) {
  if (KEEP_COOKIE_NAMES.has(name)) return true;
  if (name.startsWith('__Secure-pplx.session.')) return true;
  if (name.startsWith('__Secure-next-auth.')) return true;
  return false;
}

/**
 * @param {Record<string, string>} map
 */
export function buildCookieHeader(map) {
  return Object.entries(map)
    .filter(([, v]) => v != null && String(v).length > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * @param {string} cookieHeader
 */
export async function fetchPerplexitySession(cookieHeader) {
  const res = await fetch(SESSION_URL, {
    method: 'GET',
    headers: {
      Cookie: cookieHeader,
      Accept: 'application/json',
      'User-Agent': DEFAULT_UA,
      Referer: 'https://www.perplexity.ai/',
      Origin: 'https://www.perplexity.ai',
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Perplexity session ${res.status}: ${text.slice(0, 180)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Perplexity session: JSON không hợp lệ');
  }
  const user = data?.user;
  if (!user?.id && !user?.email) {
    throw new Error(
      'Cookie Perplexity không có session (chưa login hoặc đã hết hạn)',
    );
  }
  return {
    email: user.email || null,
    userId: user.id || null,
    name: user.name || null,
    planType:
      user.subscription_tier ||
      user.payment_tier ||
      data?.subscription_tier ||
      'perplexity',
    expiresAt: data?.expires || null,
  };
}

/**
 * Refresh profile fields for an existing account.
 * @param {import('./store.js').Account} account
 */
export async function refreshPerplexityProfile(account) {
  if (!account?.accessToken) throw new Error('Account thiếu cookie');
  return fetchPerplexitySession(account.accessToken);
}

function fingerprint(token) {
  let h = 0;
  const s = String(token);
  for (let i = 0; i < Math.min(s.length, 80); i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
