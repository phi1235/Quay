/**
 * Grok / xAI upstream using OIDC token from `grok login`.
 * Base: https://api.x.ai/v1  (OpenAI-compatible chat.completions)
 */

import { patchAccount } from './store.js';

const GROK_API_BASE =
  process.env.QUAY_GROK_BASE || 'https://api.x.ai/v1';

const TOKEN_URL =
  process.env.QUAY_GROK_TOKEN_URL || 'https://auth.x.ai/oauth2/token';

const DEFAULT_UA =
  process.env.QUAY_GROK_UA || 'quay/0.1.0 (grok-oidc)';

/** refresh if JWT expires within this window */
const REFRESH_SKEW_MS = 3 * 60 * 1000;

/** @type {Map<string, Promise<import('./store.js').Account>>} */
const refreshInflight = new Map();

/** CLI slug → real model id on api.x.ai */
const MODEL_ALIASES = {
  'quay-grok-45': 'grok-4.5',
  'quay-grok-4.5': 'grok-4.5',
  'quay-grok-4': 'grok-4.5',
  'quay-grok-build': 'grok-build',
  'quay-g45': 'grok-4.5',
};

/**
 * @param {string | undefined} model
 */
export function resolveGrokModel(model) {
  const m = String(model || 'grok-4.5').trim();
  return MODEL_ALIASES[m] || MODEL_ALIASES[m.toLowerCase()] || m;
}

function jwtExpMs(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return NaN;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = '='.repeat((4 - (payload.length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(payload + pad, 'base64').toString('utf8'));
    return typeof claims.exp === 'number' ? claims.exp * 1000 : NaN;
  } catch {
    return NaN;
  }
}

/**
 * @param {import('./store.js').Account} account
 */
function isTokenFresh(account) {
  const fromJwt = jwtExpMs(account.accessToken);
  const fromField = account.expiresAt ? Date.parse(account.expiresAt) : NaN;
  const expMs = Number.isFinite(fromJwt) ? fromJwt : fromField;
  return Number.isFinite(expMs) && expMs - Date.now() > REFRESH_SKEW_MS;
}

/**
 * @param {import('./store.js').Account} account
 */
export async function ensureGrokTokenFresh(account) {
  if (!account?.accessToken) throw new Error('Grok account thiếu accessToken');
  if (isTokenFresh(account)) return account;
  if (!account.refreshToken || !account.oidcClientId) return account;

  const key = account.id;
  const existing = refreshInflight.get(key);
  if (existing) return existing;

  const p = (async () => {
    const t0 = Date.now();
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: account.refreshToken,
      client_id: account.oidcClientId,
    });

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': DEFAULT_UA,
      },
      body,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Grok token refresh ${res.status}: ${text.slice(0, 200)}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('Grok token refresh: JSON không hợp lệ');
    }

    const accessToken = data.access_token;
    if (!accessToken) throw new Error('Grok token refresh: thiếu access_token');

    const expiresAt =
      typeof data.expires_in === 'number'
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : account.expiresAt;

    const updated = patchAccount(account.id, {
      accessToken,
      refreshToken: data.refresh_token || account.refreshToken,
      expiresAt,
      lastError: null,
    });
    console.log(
      `[grok] token refresh account=${account.email} ${Date.now() - t0}ms`,
    );
    return updated;
  })().finally(() => {
    refreshInflight.delete(key);
  });

  refreshInflight.set(key, p);
  return p;
}

/**
 * Warm token in background (import / pin) — không chặn request.
 * @param {import('./store.js').Account} account
 */
export function warmGrokToken(account) {
  ensureGrokTokenFresh(account).catch((err) => {
    console.warn(
      `[grok] warm token failed ${account?.email}:`,
      err instanceof Error ? err.message : err,
    );
  });
}

/**
 * @param {import('./store.js').Account} account
 * @param {object} body  OpenAI chat.completions body
 * @param {{ stream?: boolean, signal?: AbortSignal }} [opts]
 */
export async function upstreamGrokChat(account, body, opts = {}) {
  const t0 = Date.now();
  const fresh = await ensureGrokTokenFresh(account);
  const refreshMs = Date.now() - t0;
  const stream = Boolean(opts.stream ?? body?.stream);
  const url = `${GROK_API_BASE.replace(/\/$/, '')}/chat/completions`;

  const payload = { ...body, stream };
  payload.model = resolveGrokModel(payload.model);

  // Tránh gửi field CLI-only làm chậm / lỗi một số path
  delete payload.prompt_cache_key;
  delete payload.safety_identifier;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${fresh.accessToken}`,
      Accept: stream ? 'text/event-stream' : 'application/json',
      'User-Agent': DEFAULT_UA,
    },
    body: JSON.stringify(payload),
    signal: opts.signal,
  });
  if (refreshMs > 50) {
    console.log(`[grok] refresh overhead ${refreshMs}ms before upstream`);
  }
  return res;
}

/**
 * Convert Codex-style /v1/responses body → chat.completions messages.
 * @param {any} body
 */
export function responsesBodyToChatCompletions(body) {
  const model = resolveGrokModel(body?.model || 'grok-4.5');
  /** @type {{role:string, content:string}[]} */
  const messages = [];

  if (Array.isArray(body?.input)) {
    for (const item of body.input) {
      const role =
        item.role === 'assistant'
          ? 'assistant'
          : item.role === 'developer' || item.role === 'system'
            ? 'system'
            : 'user';
      let text = '';
      if (typeof item.content === 'string') text = item.content;
      else if (Array.isArray(item.content)) {
        text = item.content
          .map((c) => c?.text || c?.input_text || c?.output_text || '')
          .filter(Boolean)
          .join('\n');
      }
      if (text) messages.push({ role, content: text });
    }
  } else if (typeof body?.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body?.messages)) {
    return {
      model,
      messages: body.messages,
      stream: Boolean(body.stream),
      temperature: body.temperature,
      max_tokens: body.max_tokens || body.max_output_tokens,
    };
  }

  if (!messages.length) {
    messages.push({ role: 'user', content: 'hello' });
  }

  return {
    model,
    messages,
    stream: Boolean(body?.stream),
    temperature: body?.temperature,
    max_tokens: body?.max_tokens || body?.max_output_tokens,
  };
}

/**
 * chat.completion JSON → minimal responses-shaped object
 * @param {any} chatJson
 * @param {string} [model]
 */
export function chatCompletionToResponses(chatJson, model) {
  const text =
    chatJson?.choices?.[0]?.message?.content ||
    chatJson?.choices?.[0]?.text ||
    '';
  return {
    id: chatJson?.id || `resp_quay_grok_${Date.now()}`,
    object: 'response',
    status: 'completed',
    model: resolveGrokModel(model || chatJson?.model || 'grok-4.5'),
    output_text: text,
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    ],
    usage: chatJson?.usage,
  };
}

export function grokModels() {
  return ['grok-4.5', 'grok-build'].map((id) => ({
    id,
    object: 'model',
    created: 0,
    owned_by: 'xai',
  }));
}

/**
 * @param {string | undefined} model
 * @param {import('express').Request} [req]
 */
export function inferProvider(model, req) {
  const header =
    req?.headers?.['x-quay-provider'] ||
    req?.headers?.['x-provider'] ||
    '';
  const h = String(header).toLowerCase().trim();
  if (h === 'grok' || h === 'xai') return 'grok';
  if (h === 'perplexity' || h === 'pplx') return 'perplexity';
  if (h === 'codex' || h === 'openai' || h === 'chatgpt') return 'codex';

  const m = String(model || '').toLowerCase();
  // Grok CLI slugs for Perplexity (quay-pplx-*) — must check before quay-grok
  if (
    m.startsWith('pplx') ||
    m.startsWith('perplexity') ||
    m.startsWith('quay-pplx') ||
    m === 'sonar' ||
    m.startsWith('sonar-')
  ) {
    return 'perplexity';
  }
  if (
    m.startsWith('grok') ||
    m.includes('grok-') ||
    m.startsWith('quay-grok')
  ) {
    return 'grok';
  }
  return 'codex';
}
