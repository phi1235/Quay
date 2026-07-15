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
  const id = chatJson?.id || `resp_quay_${Date.now()}`;
  const modelId = model || chatJson?.model || 'grok-4.5';
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: modelId,
    output_text: text,
    output: [
      {
        id: `msg_${id}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text }],
      },
    ],
    usage: chatJson?.usage,
  };
}

/**
 * Convert OpenAI chat.completions SSE → OpenAI Responses API SSE.
 * Grok CLI agent often hits /v1/responses; chat.completion.chunk is rejected / empty.
 * @param {Response} chatSseResponse
 * @param {string} [model]
 * @returns {Response}
 */
export function chatCompletionSseToResponsesSse(chatSseResponse, model) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const respId = `resp_quay_${Date.now()}`;
  const msgId = `msg_${respId}`;
  const modelId = model || 'unknown';
  let fullText = '';
  let started = false;

  const body = new ReadableStream({
    async start(controller) {
      const emit = (obj) => {
        // data-only SSE; `type` field is required by Responses clients
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };

      try {
        if (!chatSseResponse.ok || !chatSseResponse.body) {
          const errText = await chatSseResponse.text().catch(() => '');
          emit({
            type: 'response.failed',
            response: {
              id: respId,
              object: 'response',
              status: 'failed',
              error: { message: errText.slice(0, 400) || `upstream ${chatSseResponse.status}` },
            },
          });
          controller.close();
          return;
        }

        emit({
          type: 'response.created',
          response: {
            id: respId,
            object: 'response',
            created_at: Math.floor(Date.now() / 1000),
            status: 'in_progress',
            model: modelId,
            output: [],
          },
        });
        emit({
          type: 'response.in_progress',
          response: {
            id: respId,
            object: 'response',
            status: 'in_progress',
            model: modelId,
            output: [],
          },
        });

        const reader = chatSseResponse.body.getReader();
        let buf = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split(/\r?\n/);
          buf = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            let chunk;
            try {
              chunk = JSON.parse(raw);
            } catch {
              continue;
            }
            const choice = chunk?.choices?.[0];
            const delta = choice?.delta || {};
            const content =
              typeof delta.content === 'string'
                ? delta.content
                : typeof delta.text === 'string'
                  ? delta.text
                  : '';

            if (!started && (content || delta.role === 'assistant')) {
              started = true;
              emit({
                type: 'response.output_item.added',
                output_index: 0,
                item: {
                  id: msgId,
                  type: 'message',
                  role: 'assistant',
                  status: 'in_progress',
                  content: [],
                },
              });
              emit({
                type: 'response.content_part.added',
                item_id: msgId,
                output_index: 0,
                content_index: 0,
                part: { type: 'output_text', text: '' },
              });
            }

            if (content) {
              if (!started) {
                started = true;
                emit({
                  type: 'response.output_item.added',
                  output_index: 0,
                  item: {
                    id: msgId,
                    type: 'message',
                    role: 'assistant',
                    status: 'in_progress',
                    content: [],
                  },
                });
                emit({
                  type: 'response.content_part.added',
                  item_id: msgId,
                  output_index: 0,
                  content_index: 0,
                  part: { type: 'output_text', text: '' },
                });
              }
              fullText += content;
              emit({
                type: 'response.output_text.delta',
                item_id: msgId,
                output_index: 0,
                content_index: 0,
                delta: content,
              });
            }
          }
        }

        if (!started) {
          // Empty upstream — still emit a completed empty message so client does not hang
          started = true;
          emit({
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              id: msgId,
              type: 'message',
              role: 'assistant',
              status: 'in_progress',
              content: [],
            },
          });
          emit({
            type: 'response.content_part.added',
            item_id: msgId,
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text: '' },
          });
        }

        emit({
          type: 'response.output_text.done',
          item_id: msgId,
          output_index: 0,
          content_index: 0,
          text: fullText,
        });
        emit({
          type: 'response.content_part.done',
          item_id: msgId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: fullText },
        });
        emit({
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: fullText }],
          },
        });
        emit({
          type: 'response.completed',
          response: {
            id: respId,
            object: 'response',
            created_at: Math.floor(Date.now() / 1000),
            status: 'completed',
            model: modelId,
            output_text: fullText,
            output: [
              {
                id: msgId,
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: fullText }],
              },
            ],
          },
        });
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (err) {
        try {
          emit({
            type: 'error',
            error: { message: err instanceof Error ? err.message : String(err) },
          });
        } catch {
          /* ignore */
        }
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      }
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
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
