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

/**
 * CLI / OpenAI model id → Perplexity model_preference
 * Keys from /rest/models/config (Pro tier, unlocked search models only).
 * Max-locked (Sol / Opus) intentionally omitted.
 */
const MODEL_ALIASES = {
  // --- Best (default search) ---
  pplx: 'pplx_pro',
  perplexity: 'pplx_pro',
  'pplx-default': 'pplx_pro',
  'pplx-best': 'pplx_pro',
  'pplx-pro': 'pplx_pro',
  pplx_pro: 'pplx_pro',
  turbo: 'turbo',
  'pplx-turbo': 'turbo',

  // --- Sonar 2 ---
  sonar: 'experimental',
  'sonar-2': 'experimental',
  'pplx-sonar': 'experimental',
  'pplx-sonar-2': 'experimental',
  experimental: 'experimental',

  // --- GPT-5.6 Terra (Pro) ---
  'pplx-gpt-5.6-terra': 'gpt56_terra',
  'pplx-gpt56-terra': 'gpt56_terra',
  'pplx-terra': 'gpt56_terra',
  gpt56_terra: 'gpt56_terra',
  'pplx-gpt-5.6-terra-thinking': 'gpt56_terra_thinking',
  gpt56_terra_thinking: 'gpt56_terra_thinking',

  // --- Gemini 3.1 Pro (Pro; reasoning-only in config) ---
  'pplx-gemini': 'gemini31pro_high',
  'pplx-gemini-3.1-pro': 'gemini31pro_high',
  'pplx-gemini-31-pro': 'gemini31pro_high',
  gemini31pro_high: 'gemini31pro_high',
  gemini31pro_low: 'gemini31pro_low',

  // --- Claude Sonnet 5 (Pro) ---
  'pplx-claude': 'claude50sonnet',
  'pplx-claude-sonnet': 'claude50sonnet',
  'pplx-claude-sonnet-5': 'claude50sonnet',
  'pplx-claude-5': 'claude50sonnet',
  claude50sonnet: 'claude50sonnet',
  'pplx-claude-sonnet-5-thinking': 'claude50sonnetthinking',
  claude50sonnetthinking: 'claude50sonnetthinking',

  // --- GLM 5.2 (Pro; reasoning-only) ---
  'pplx-glm': 'glm_5_2',
  'pplx-glm-5.2': 'glm_5_2',
  'pplx-glm-5-2': 'glm_5_2',
  glm_5_2: 'glm_5_2',

  // --- Kimi K2.6 (Pro) ---
  'pplx-kimi': 'kimik26instant',
  'pplx-kimi-k2.6': 'kimik26instant',
  'pplx-kimi-k26': 'kimik26instant',
  kimik26instant: 'kimik26instant',
  'pplx-kimi-thinking': 'kimik26thinking',
  kimik26thinking: 'kimik26thinking',

  // --- Grok 4.5 on Perplexity (Pro) ---
  'pplx-grok': 'grok45low',
  'pplx-grok-4.5': 'grok45low',
  'pplx-grok-45': 'grok45low',
  grok45low: 'grok45low',
  'pplx-grok-thinking': 'grok45medium',
  grok45medium: 'grok45medium',

  // --- Nemotron 3 Ultra (Pro; reasoning-only) ---
  'pplx-nemotron': 'nv_nemotron_3_ultra',
  'pplx-nemotron-3-ultra': 'nv_nemotron_3_ultra',
  'pplx-nemotron-ultra': 'nv_nemotron_3_ultra',
  nv_nemotron_3_ultra: 'nv_nemotron_3_ultra',

  // --- Grok CLI slugs (apply-grok; model field is pplx-*, slug may leak) ---
  'quay-pplx-pro': 'pplx_pro',
  'quay-pplx-best': 'pplx_pro',
  'quay-pplx-turbo': 'turbo',
  'quay-pplx-sonar': 'experimental',
  'quay-pplx-sonar-2': 'experimental',
  'quay-pplx-terra': 'gpt56_terra',
  'quay-pplx-gpt56-terra': 'gpt56_terra',
  'quay-pplx-gemini': 'gemini31pro_high',
  'quay-pplx-claude': 'claude50sonnet',
  'quay-pplx-claude-sonnet': 'claude50sonnet',
  'quay-pplx-glm': 'glm_5_2',
  'quay-pplx-kimi': 'kimik26instant',
  'quay-pplx-grok': 'grok45low',
  'quay-pplx-grok-45': 'grok45low',
  'quay-pplx-nemotron': 'nv_nemotron_3_ultra',
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
      // Prefer progressive text fields when the backend supports them
      send_back_text_in_streaming_api: true,
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

/** OpenAI-style model list: Pro-unlocked search models from web UI */
export function perplexityModels() {
  const ids = [
    'pplx-pro', // Best
    'pplx-turbo', // Best (turbo)
    'pplx-sonar', // Sonar 2
    'pplx-gpt-5.6-terra',
    'pplx-gemini',
    'pplx-claude-sonnet',
    'pplx-glm',
    'pplx-kimi',
    'pplx-grok',
    'pplx-nemotron',
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
 * Flatten one message content to plain text.
 * @param {any} content
 */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => c?.text || c?.input_text || c?.output_text || '')
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Build a Perplexity web query from OpenAI-style messages.
 *
 * Grok CLI injects a huge coding-agent system prompt + tool schemas. Dumping
 * that into Perplexity's query_str makes the upstream fail with
 * status=FAILED / "Error in processing query." — so we:
 *   - drop system/developer prompts (PPLX is a search chat, not an agent host)
 *   - drop tool-call noise
 *   - keep only a short recent user/assistant tail
 *   - hard-cap length
 *
 * @param {Array<{role?: string, content?: any, tool_calls?: any}> | undefined} messages
 */
function messagesToQuery(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 'hello';

  /** @type {{role: string, text: string}[]} */
  const turns = [];
  for (const m of messages) {
    const role = String(m?.role || 'user').toLowerCase();
    // Never forward agent system / tool plumbing to Perplexity
    if (
      role === 'system' ||
      role === 'developer' ||
      role === 'tool' ||
      role === 'function'
    ) {
      continue;
    }
    // Skip pure tool-call assistant messages (no user-visible text)
    if (role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
      const t = contentToText(m?.content).trim();
      if (!t) continue;
    }
    const text = contentToText(m?.content).trim();
    if (!text) continue;
    turns.push({ role: role === 'assistant' ? 'assistant' : 'user', text });
  }

  if (!turns.length) {
    // Fallback: last non-empty content anywhere (rare)
    for (let i = messages.length - 1; i >= 0; i--) {
      const t = contentToText(messages[i]?.content).trim();
      if (t) return truncateQuery(t);
    }
    return 'hello';
  }

  // Prefer last user turn alone for short chit-chat; add brief prior context if multi-turn
  const lastUserIdx = (() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === 'user') return i;
    }
    return turns.length - 1;
  })();

  const lastUser = turns[lastUserIdx];
  // Include at most 2 prior turns (user/assistant) for context — still small
  const start = Math.max(0, lastUserIdx - 2);
  const slice = turns.slice(start, lastUserIdx + 1);

  if (slice.length === 1) {
    return truncateQuery(lastUser.text);
  }

  const parts = slice.map((t) =>
    t.role === 'assistant' ? `[assistant] ${t.text}` : t.text,
  );
  return truncateQuery(parts.join('\n\n'));
}

/** @param {string} q */
function truncateQuery(q) {
  const MAX = 4000; // Perplexity web fails / degrades on huge agent dumps
  const s = String(q || '').trim();
  if (!s) return 'hello';
  if (s.length <= MAX) return s;
  return s.slice(0, MAX - 20) + '\n…[truncated]';
}

/**
 * @param {Response} res
 */
async function collectAnswerFromSse(res) {
  const text = await res.text();
  /** @type {string[]} */
  let chunkParts = [];
  let answer = '';
  let lastFinal = '';
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const ev = JSON.parse(raw);
      const extracted = extractAnswer(ev, chunkParts);
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
 * Rebuild progressive markdown from Perplexity `chunks` + `chunk_starting_offset`
 * (offset is a chunk index, not a character index).
 * @param {any} ev
 * @param {string[]} chunkParts  mutable accumulator across SSE events
 * @returns {string}
 */
function applyMarkdownChunks(ev, chunkParts) {
  const blocks = Array.isArray(ev?.blocks) ? ev.blocks : [];
  let best = '';
  for (const b of blocks) {
    const md = b?.markdown_block;
    if (!md || typeof md !== 'object') continue;
    if (typeof md.answer === 'string' && md.answer) {
      best = md.answer;
      continue;
    }
    const chunks = Array.isArray(md.chunks) ? md.chunks : null;
    if (!chunks || !chunks.length) continue;
    const offset = Number.isFinite(md.chunk_starting_offset)
      ? Math.max(0, Number(md.chunk_starting_offset))
      : 0;
    const strChunks = chunks.map((c) => (typeof c === 'string' ? c : String(c ?? '')));
    // Replace from chunk index `offset` (SSE deltas are partial arrays)
    chunkParts.splice(offset, chunkParts.length - offset, ...strChunks);
    const joined = chunkParts.join('');
    if (joined.length >= best.length) best = joined;
  }
  return best;
}

/**
 * @param {any} ev
 * @param {string[]} [chunkParts]
 */
function extractAnswer(ev, chunkParts) {
  if (!ev || typeof ev !== 'object') return '';

  // Prefer explicit answer fields (final / completed events)
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

  // Progressive stream: only `chunks` until COMPLETED
  if (chunkParts) {
    const fromChunks = applyMarkdownChunks(ev, chunkParts);
    if (fromChunks) return fromChunks;
  } else {
    // stateless fallback: join chunks on this event only (may be partial)
    for (const b of blocks) {
      const md = b?.markdown_block;
      const chunks = md?.chunks;
      if (Array.isArray(chunks) && chunks.length) {
        const joined = chunks.map((c) => (typeof c === 'string' ? c : '')).join('');
        if (joined.length > best.length) best = joined;
      }
    }
    if (best) return best;
  }

  // fallback: plan FINAL step embedded in text JSON
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
 * Emits progressive `delta.content` from markdown `chunks` (not only final `answer`).
 * @param {Response} upstream
 * @param {string} model
 */
function streamOpenAiFromPplxSse(upstream, model) {
  const id = `chatcmpl_pplx_${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  let sentRole = false;
  let lastLen = 0;
  /** @type {string[]} progressive chunk index assembly */
  const chunkParts = [];
  /** @type {string | null} */
  let failReason = null;

  const body = new ReadableStream({
    async start(controller) {
      /**
       * Match xAI/OpenAI chat.completion.chunk shape closely.
       * Omit finish_reason until the terminal chunk (null fields break some strict deserializers).
       * @param {Record<string, any>} delta
       * @param {string | undefined} [finishReason]
       */
      const pushChunk = (delta, finishReason) => {
        /** @type {any} */
        const choice = { index: 0, delta };
        if (finishReason !== undefined) choice.finish_reason = finishReason;
        const obj = {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [choice],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      const ensureRole = () => {
        if (sentRole) return;
        pushChunk({ role: 'assistant' });
        sentRole = true;
      };
      const emitAnswer = (answer) => {
        if (!answer) return;
        ensureRole();
        if (answer.length > lastLen) {
          const delta = answer.slice(lastLen);
          lastLen = answer.length;
          pushChunk({ content: delta });
        } else if (answer.length < lastLen) {
          lastLen = answer.length;
          pushChunk({ content: answer });
        }
      };
      try {
        if (!upstream.body) {
          ensureRole();
          pushChunk({}, 'stop');
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
            if (ev?.status === 'FAILED') {
              failReason =
                (typeof ev.text === 'string' && ev.text) ||
                ev?.error?.message ||
                'Error in processing query.';
              continue;
            }
            emitAnswer(extractAnswer(ev, chunkParts));
          }
        }
        if (buf.startsWith('data:')) {
          const raw = buf.slice(5).trim();
          if (raw && raw !== '[DONE]') {
            try {
              const ev = JSON.parse(raw);
              if (ev?.status === 'FAILED') {
                failReason =
                  (typeof ev.text === 'string' && ev.text) ||
                  'Error in processing query.';
              } else {
                emitAnswer(extractAnswer(ev, chunkParts));
              }
            } catch {
              /* ignore */
            }
          }
        }

        ensureRole();
        if (lastLen === 0) {
          const msg = failReason
            ? `(Perplexity failed: ${failReason})`
            : '(Perplexity returned no text for this query. Try again or switch model.)';
          pushChunk({ content: msg });
          lastLen = 1;
        }
        pushChunk({}, 'stop');
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
      'Content-Type': 'text/event-stream; charset=utf-8',
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
