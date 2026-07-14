/**
 * Import ChatGPT / Codex token JSON formats (Cockpit-compatible subset):
 * - Sub2API export: { exported_at, accounts: [{ platform, type, credentials }] }
 * - auth.json style: { tokens: { access_token, id_token?, refresh_token? } }
 * - flat: { access_token | accessToken, email?, chatgpt_account_id? }
 * - array of any of the above
 * - raw JWT / token line(s)
 */

import fs from 'node:fs';
import { upsertAccount } from './store.js';

/**
 * @param {string} input path or raw JSON/text
 * @param {{ isPath?: boolean }} [opts]
 */
export function importTokenInput(input, opts = {}) {
  const text = opts.isPath ? fs.readFileSync(input, 'utf8') : input;
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Empty input');

  /** @type {ReturnType<typeof upsertAccount>[]} */
  const imported = [];

  // raw token lines (not JSON object)
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    for (const line of trimmed.split(/\r?\n/)) {
      const token = line.trim();
      if (!token || token.startsWith('#')) continue;
      imported.push(
        upsertAccount({
          accessToken: stripBearer(token),
          source: 'raw-token-line',
        }),
      );
    }
    if (imported.length === 0) throw new Error('No tokens found');
    return imported;
  }

  const parsed = JSON.parse(trimmed);
  const values = Array.isArray(parsed) ? parsed : [parsed];

  for (const value of values) {
    if (looksLikeSub2Api(value)) {
      for (const acc of value.accounts || []) {
        if (!isOpenAiOauth(acc)) continue;
        const c = acc.credentials || {};
        const token = c.access_token || c.accessToken;
        if (!token) continue;
        imported.push(
          upsertAccount({
            accessToken: stripBearer(token),
            email: c.email || acc.name || acc.email,
            accountId: c.chatgpt_account_id || c.account_id || c.accountId,
            userId: c.chatgpt_user_id || c.user_id || c.userId,
            planType: c.plan_type || c.planType || c.chatgpt_plan_type,
            expiresAt: c.expires_at || c.expiresAt || null,
            source: acc.extra?.source || 'sub2api',
          }),
        );
      }
      continue;
    }

    const candidates = extractAccessTokens(value);
    if (candidates.length === 0) {
      // maybe NDJSON style object without credentials nesting
      continue;
    }
    for (const c of candidates) {
      imported.push(upsertAccount(c));
    }
  }

  if (imported.length === 0) {
    throw new Error(
      'No importable OpenAI/Codex access_token found. Expected Sub2API export, auth.json tokens, or access_token field.',
    );
  }
  return imported;
}

function looksLikeSub2Api(value) {
  return (
    value &&
    typeof value === 'object' &&
    Array.isArray(value.accounts) &&
    (value.exported_at != null ||
      value.proxies != null ||
      value.accounts.some((a) => a && a.credentials && a.platform))
  );
}

function isOpenAiOauth(acc) {
  if (!acc || typeof acc !== 'object') return false;
  const platform = String(acc.platform || '').toLowerCase();
  const type = String(acc.type || '').toLowerCase();
  // accept openai oauth, or any account with credentials.access_token
  if (platform && platform !== 'openai') return false;
  if (type && type !== 'oauth' && type !== 'token') return false;
  return true;
}

function stripBearer(token) {
  const t = String(token || '').trim();
  if (t.toLowerCase().startsWith('bearer ')) return t.slice(7).trim();
  return t;
}

/**
 * @param {any} value
 * @returns {Array<{accessToken:string,email?:string,accountId?:string,userId?:string,planType?:string,expiresAt?:string,source?:string}>}
 */
function extractAccessTokens(value) {
  if (!value || typeof value !== 'object') return [];

  // auth.json
  if (value.tokens && typeof value.tokens === 'object') {
    const t = value.tokens.access_token || value.tokens.accessToken;
    if (t) {
      return [
        {
          accessToken: stripBearer(t),
          email: value.email,
          accountId: value.tokens.account_id || value.account_id || value.chatgpt_account_id,
          source: 'auth.json',
        },
      ];
    }
  }

  // credentials block
  if (value.credentials && typeof value.credentials === 'object') {
    const c = value.credentials;
    const t = c.access_token || c.accessToken;
    if (t) {
      return [
        {
          accessToken: stripBearer(t),
          email: c.email || value.email || value.name,
          accountId: c.chatgpt_account_id || c.account_id,
          userId: c.chatgpt_user_id || c.user_id,
          planType: c.plan_type || c.planType,
          expiresAt: c.expires_at || c.expiresAt,
          source: value.platform ? 'credentials' : 'credentials',
        },
      ];
    }
  }

  // flat
  const token =
    value.access_token ||
    value.accessToken ||
    value.token ||
    (typeof value.authorization === 'string' ? stripBearer(value.authorization) : null);
  if (token && String(token).length > 20) {
    return [
      {
        accessToken: stripBearer(token),
        email: value.email || value.name,
        accountId: value.chatgpt_account_id || value.account_id || value.accountId,
        userId: value.chatgpt_user_id || value.user_id,
        planType: value.plan_type || value.planType,
        expiresAt: value.expires_at || value.expiresAt,
        source: 'flat-json',
      },
    ];
  }

  return [];
}
