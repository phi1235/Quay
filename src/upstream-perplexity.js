/**
 * Perplexity web session upstream:
 *   POST https://www.perplexity.ai/rest/sse/perplexity_ask
 * Auth via browser cookies (__Secure-next-auth.session-token, …)
 */

import crypto from 'node:crypto';
import { responsesBodyToChatCompletions } from './upstream-grok.js';

const ASK_URL =
  process.env.QUAY_PPLX_ASK_URL ||
  'https://www.perplexity.ai/rest/sse/perplexity_ask';

const DEFAULT_UA =
  process.env.QUAY_PPLX_UA ||
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** CLI / OpenAI model id → Perplexity model_preference */
const MODEL_ALIASES = {
  // defaults
  'pplx': 'turbo',
  'perplexity': 'turbo',
  'pplx-default': 'turbo',
  'pplx-best': 'pplx_pro',
  'pplx-pro': 'pplx_pro',
  'pplx_pro': 'pplx_pro',
  'turbo': 'turbo',
  'pplx-turbo': 'turbo',
  // Grok CLI slugs (apply-grok → model field is already pplx-*, but slug may leak)
  'quay-pplx-pro': 'pplx_pro',
  'quay-pplx-turbo': 'turbo',
  'quay-pplx-sonar': 'turbo',
  'quay-pplx-grok': 'grok',
  'quay-pplx-claude': 'claude45sonnet',
  'quay-pplx-gemini': 'gemini2flash',
  // sonar
  'sonar': 'turbo',
  'sonar-2': 'turbo',
  'pplx-sonar': 'turbo',
  'pplx-sonar-2': 'turbo',
  // models shown in web UI (best-effort preference keys)
  'pplx-grok': 'grok',
  'pplx-grok-4.5': 'grok',
  'pplx-grok-45': 'grok',
  'pplx-claude-sonnet': 'claude45sonnet',
  'pplx-claude-sonnet-5': 'claude45sonnet',
  'pplx-gemini': 'gemini2flash',
  'pplx-gemini-3.1-pro': 'gemini2flash',
  'pplx-gpt-5.6-terra': 'gpt45',
  'pplx-gpt56-terra': 'gpt45',
  'pplx-glm': 'experimental',
  'pplx-glm-5.2': 'experimental',
};

/**
 * @param {string | undefined} model
 */
export function resolvePerplexityModel(model) {
  let m = String(model || 'pplx-pro').trim();
  // strip quay- prefix if CLI ever sends the slug as model id
  if (m.toLowerCase().startsWith('quay-')) m = m.slice(5);
  const key = m.toLowerCase();
  return (
    MODEL_ALIASES[key] ||
    MODEL_ALIASES[m] ||
    MODEL_ALIASES[`quay-${key}`] ||
    (key.startsWith('pplx') ? 'turbo' : m)
  );
}

/**
 * @param {string | undefined} model
 * @param {import('express').Request} [req]
 * @returns {boolean}
 */
export function isPerplexityModel(model, req) {
  const header =
    req?.headers?.['x-quay-provider'] ||
    req?.headers?.['x-provider'] ||
    '';
  const h = String(header).toLowerCase().trim();
  if (h === 'perplexity' || h === 'pplx') return true;
  const m = String(model || '').toLowerCase();
  if (!m) return false;
  return (
    m.startsWith('pplx') ||
    m.startsWith('perplexity') ||
    m === 'sonar' ||
    m.startsWith('sonar-')
  );
}

/**
 * @param {import('./store.js').Account} account
 * @param {object} body  OpenAI chat.completions body
 * @param {{ stream?: boolean, signal?: AbortSignal }} [opts]
 * @returns {Promise<Response>}
 */
export async function upstreamPerplexityChat(account, body, opts = {}) {
  if (!account?.accessToken) {
    throw new Error('Perplexity account thiếu cookie (accessToken)');
  }

  const stream = Boolean(opts.stream ?? body?.stream);
  const modelPref = resolvePerplexityModel(body?.model);
  const query = messagesToQuery(body?.messages);
  const visitorId = cookieValue(account.accessToken, 'pplx.visitor-id') || crypto.randomUUID();

  const payload = {
    query_str: query,
    params: {
      attachments: [],
      language: 'en-US',
      timezone: 'Asia/Ho_Chi_Minh',
      search_focus: 'internet',
      sources: [],
      frontend_uuid: crypto.randomUUID(),
      mode: 'copilot',
      model_preference: modelPref,
      is_related_query: false,
      is_sponsored: false,
      visitor_id: visitorId,
      frontend_context_uuid: crypto.randomUUID(),
      prompt_source: 'user',
      query_source: 'home',
      is_incognito: false,
      use_schematized_api: true,
      send_back_text_in_streaming_api: false,
    },
  };

  const res = await fetch(ASK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Cookie: account.accessToken,
      'User-Agent': DEFAULT_UA,
      Origin: 'https://www.perplexity.ai',
      Referer: 'https://www.perplexity.ai/',
    },
    body: JSON.stringify(payload),
    signal: opts.signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return new Response(
      JSON.stringify({
        error: {
          message: `Perplexity upstream ${res.status}: ${errText.slice(0, 240)}`,
          type: 'perplexity_upstream_error',
          status: res.status,
        },
      }),
      {
        status: res.status,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  const displayModel = body?.model || 'pplx-pro';
  if (stream) {
    return streamOpenAiFromPplxSse(res, displayModel);
  }
  const answer = await collectAnswerFromSse(res);
  const chat = toChatCompletion(answer, displayModel);
  return new Response(JSON.stringify(chat), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * @param {any} body  responses or chat body
 */
export function perplexityBodyToChatCompletions(body) {
  if (Array.isArray(body?.messages)) {
    return {
      model: body.model || 'pplx-pro',
      messages: body.messages,
      stream: Boolean(body.stream),
    };
  }
  return responsesBodyToChatCompletions({
    ...body,
    model: body?.model || 'pplx-pro',
  });
}

export function perplexityModels() {
  const ids = [
    'pplx-pro',
    'pplx-turbo',
    'pplx-sonar',
    'pplx-grok',
    'pplx-claude-sonnet',
    'pplx-gemini',
    'pplx-gpt-5.6-terra',
    'sonar',
  ];
  return ids.map((id) => ({
    id,
    object: 'model',
    created: 0,
    owned_by: 'perplexity',
  }));
}

/**
 * @param {Array<{role?: string, content?: any}> | undefined} messages
 */
function messagesToQuery(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 'hello';
  const parts = [];
  for (const m of messages) {
    const role = m?.role || 'user';
    let text = '';
    if (typeof m?.content === 'string') text = m.content;
    else if (Array.isArray(m?.content)) {
      text = m.content
        .map((c) => c?.text || c?.input_text || c?.output_text || '')
        .filter(Boolean)
        .join('\n');
    }
    if (!text) continue;
    if (role === 'system' || role === 'developer') {
      parts.push(`[system] ${text}`);
    } else if (role === 'assistant') {
      parts.push(`[assistant] ${text}`);
    } else {
      parts.push(text);
    }
  }
  return parts.join('\n\n').trim() || 'hello';
}

/**
 * @param {Response} res
 */
async function collectAnswerFromSse(res) {
  const text = await res.text();
  let answer = '';
  let lastFinal = '';
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const ev = JSON.parse(raw);
      const extracted = extractAnswer(ev);
      if (extracted) {
        answer = extracted;
        if (ev.final || ev.status === 'COMPLETED' || ev.text_completed) {
          lastFinal = extracted;
        }
      }
    } catch {
      /* ignore partial */
    }
  }
  return lastFinal || answer || '';
}

/**
 * @param {any} ev
 */
function extractAnswer(ev) {
  if (!ev || typeof ev !== 'object') return '';
  if (typeof ev.text === 'string' && ev.text && !ev.text.startsWith('[{')) {
    // sometimes text is JSON dump of steps — skip that form if blocks exist
  }
  const blocks = Array.isArray(ev.blocks) ? ev.blocks : [];
  let best = '';
  for (const b of blocks) {
    const md = b?.markdown_block;
    if (md && typeof md.answer === 'string' && md.answer) {
      best = md.answer;
    }
    const ab = b?.answer_block;
    if (ab && typeof ab.answer === 'string' && ab.answer) {
      best = ab.answer;
    }
  }
  if (best) return best;
  // fallback: plan FINAL step
  if (typeof ev.text === 'string' && ev.text.includes('"answer"')) {
    try {
      const arr = JSON.parse(ev.text);
      if (Array.isArray(arr)) {
        for (const step of arr) {
          if (step?.step_type === 'FINAL' && step?.content?.answer) {
            const a = step.content.answer;
            if (typeof a === 'string') {
              try {
                const inner = JSON.parse(a);
                if (inner?.answer) return String(inner.answer);
              } catch {
                return a;
              }
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  return best;
}

/**
 * @param {string} answer
 * @param {string} model
 */
function toChatCompletion(answer, model) {
  return {
    id: `chatcmpl_pplx_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: answer || '' },
        finish_reason: 'stop',
      },
    ],
    usage: undefined,
  };
}

/**
 * Convert Perplexity SSE → OpenAI chat.completions SSE.
 * @param {Response} upstream
 * @param {string} model
 */
function streamOpenAiFromPplxSse(upstream, model) {
  const id = `chatcmpl_pplx_${Date.now()}`;
  const encoder = new TextEncoder();
  let sentRole = false;
  let lastLen = 0;

  const body = new ReadableStream({
    async start(controller) {
      const push = (obj) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      try {
        if (!upstream.body) {
          push({
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
          });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
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
            let ev;
            try {
              ev = JSON.parse(raw);
            } catch {
              continue;
            }
            const answer = extractAnswer(ev);
            if (!answer) continue;
            if (!sentRole) {
              push({
                id,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
              });
              sentRole = true;
            }
            if (answer.length > lastLen) {
              const delta = answer.slice(lastLen);
              lastLen = answer.length;
              push({
                id,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
              });
            }
            if (ev.final || ev.status === 'COMPLETED') {
              // keep reading until stream ends
            }
          }
        }

        push({
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        });
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (err) {
        try {
          controller.error(err);
        } catch {
          controller.close();
        }
      }
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

/**
 * @param {string} cookieHeader
 * @param {string} name
 */
function cookieValue(cookieHeader, name) {
  const re = new RegExp(
    `(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`,
  );
  const m = String(cookieHeader || '').match(re);
  return m ? decodeURIComponent(m[1]) : null;
}
