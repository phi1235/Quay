/**
 * ChatGPT web conversation upstream (browser chat path, not Codex agent).
 *   POST https://chatgpt.com/backend-api/conversation
 *
 * Free / Plus tokens that work on chatgpt.com but 401 on /codex can use this.
 * Same account pool as provider `codex` (ChatGPT session JWT).
 */

import crypto from 'node:crypto';
import { responsesBodyToChatCompletions } from './upstream-grok.js';

const CONV_URL =
  process.env.QUAY_CHATGPT_CONV_URL ||
  'https://chatgpt.com/backend-api/conversation';

const DEFAULT_UA =
  process.env.QUAY_CHATGPT_UA ||
  process.env.QUAY_USER_AGENT ||
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * OpenAI / Grok CLI model id → ChatGPT web model slug
 * (from /backend-api/models for free tier).
 */
const MODEL_ALIASES = {
  // defaults
  'chatgpt-web': 'auto',
  chatgpt: 'auto',
  'chatgpt-auto': 'auto',
  'quay-chatgpt': 'auto',
  'quay-chatgpt-web': 'auto',
  'chatgpt-web-auto': 'auto',

  // named web models
  'chatgpt-web-5.3': 'gpt-5-3',
  'chatgpt-web-gpt-5-3': 'gpt-5-3',
  'chatgpt-5-3': 'gpt-5-3',
  'gpt-5-3-web': 'gpt-5-3',

  'chatgpt-web-mini': 'gpt-5-mini',
  'chatgpt-mini': 'gpt-5-mini',
  'quay-chatgpt-mini': 'gpt-5-mini',
  'gpt-5-mini-web': 'gpt-5-mini',

  'chatgpt-web-5.5': 'gpt-5-5',
  'chatgpt-web-5.5-mini': 'gpt-5-5-mini',
  'chatgpt-web-5.3-mini': 'gpt-5-3-mini',

  // pass-through common web slugs
  auto: 'auto',
  'gpt-5-3': 'gpt-5-3',
  'gpt-5-5': 'gpt-5-5',
  'gpt-5-mini': 'gpt-5-mini',
  'gpt-5-3-mini': 'gpt-5-3-mini',
  'gpt-5-5-mini': 'gpt-5-5-mini',
};

/**
 * Models that must use web conversation (not Codex backend).
 * @param {string | undefined} model
 */
export function isChatgptWebModel(model) {
  const m = String(model || '').toLowerCase().trim();
  if (!m) return false;
  if (m.startsWith('chatgpt-web')) return true;
  if (m.startsWith('quay-chatgpt')) return true;
  if (m === 'chatgpt' || m === 'chatgpt-auto' || m === 'chatgpt-mini') return true;
  if (m.endsWith('-web') && (m.startsWith('gpt-') || m.startsWith('chatgpt-'))) {
    return true;
  }
  // bare aliases that resolve via MODEL_ALIASES but would otherwise hit Codex
  if (
    m === 'auto' ||
    m === 'gpt-5-3' ||
    m === 'gpt-5-5' ||
    m === 'gpt-5-mini' ||
    m === 'gpt-5-3-mini' ||
    m === 'gpt-5-5-mini'
  ) {
    // Only force web when client used explicit web-ish names above.
    // Bare gpt-5-3 stays Codex unless prefixed chatgpt-web / quay-chatgpt.
    return false;
  }
  return Boolean(MODEL_ALIASES[m] && m.startsWith('chatgpt'));
}

/**
 * @param {string | undefined} model
 */
export function resolveChatgptWebModel(model) {
  let m = String(model || 'chatgpt-web').trim();
  if (m.toLowerCase().startsWith('quay-')) m = m.slice(5);
  const key = m.toLowerCase();
  return MODEL_ALIASES[key] || MODEL_ALIASES[key.replace(/_/g, '-')] || 'auto';
}

/**
 * @param {import('./store.js').Account} account
 * @param {object} body  OpenAI chat.completions body
 * @param {{ stream?: boolean, signal?: AbortSignal }} [opts]
 * @returns {Promise<Response>}
 */
export async function upstreamChatgptWebChat(account, body, opts = {}) {
  if (!account?.accessToken) {
    throw new Error('ChatGPT account thiếu accessToken');
  }

  const stream = Boolean(opts.stream ?? body?.stream);
  const webModel = resolveChatgptWebModel(body?.model);
  const prompt = messagesToPrompt(body?.messages);
  const deviceId = crypto.randomUUID();
  const msgId = crypto.randomUUID();
  const parentId = crypto.randomUUID();

  const payload = {
    action: 'next',
    messages: [
      {
        id: msgId,
        author: { role: 'user' },
        content: { content_type: 'text', parts: [prompt] },
        metadata: {},
      },
    ],
    parent_message_id: parentId,
    model: webModel,
    timezone_offset_min: -420,
    history_and_training_disabled: true,
    conversation_mode: { kind: 'primary_assistant' },
    force_paragen: false,
    force_rate_limit: false,
    force_use_sse: true,
    websocket_request_id: crypto.randomUUID(),
  };

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: `Bearer ${account.accessToken}`,
    'User-Agent': DEFAULT_UA,
    'oai-language': 'en-US',
    'oai-device-id': deviceId,
    Origin: 'https://chatgpt.com',
    Referer: 'https://chatgpt.com/',
  };
  if (account.accountId) {
    headers['ChatGPT-Account-Id'] = account.accountId;
    headers['Chatgpt-Account-Id'] = account.accountId;
  }

  const res = await fetch(CONV_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: opts.signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return new Response(
      JSON.stringify({
        error: {
          message: `ChatGPT web upstream ${res.status}: ${errText.slice(0, 240)}`,
          type: 'chatgpt_web_upstream_error',
          status: res.status,
        },
      }),
      {
        status: res.status,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  const displayModel = body?.model || 'chatgpt-web';
  if (stream) {
    return streamOpenAiFromWebSse(res, displayModel);
  }
  const answer = await collectAnswerFromSse(res);
  return new Response(JSON.stringify(toChatCompletion(answer, displayModel)), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * @param {any} body  responses or chat body
 */
export function chatgptWebBodyToChatCompletions(body) {
  if (Array.isArray(body?.messages)) {
    return {
      model: body.model || 'chatgpt-web',
      messages: body.messages,
      stream: Boolean(body.stream),
    };
  }
  return responsesBodyToChatCompletions({
    ...body,
    model: body?.model || 'chatgpt-web',
  });
}

/** OpenAI-style model list for web chat */
export function chatgptWebModels() {
  const ids = [
    'chatgpt-web',
    'chatgpt-web-mini',
    'chatgpt-web-5.3',
    'chatgpt-web-5.5',
  ];
  return ids.map((id) => ({
    id,
    object: 'model',
    created: 0,
    owned_by: 'chatgpt-web',
  }));
}

/**
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
 * Build a single user prompt from OpenAI messages.
 * Drop agent system/tools (same rationale as Perplexity).
 * @param {Array<{role?: string, content?: any, tool_calls?: any}> | undefined} messages
 */
function messagesToPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 'hello';

  /** @type {{role: string, text: string}[]} */
  const turns = [];
  for (const m of messages) {
    const role = String(m?.role || 'user').toLowerCase();
    if (
      role === 'system' ||
      role === 'developer' ||
      role === 'tool' ||
      role === 'function'
    ) {
      continue;
    }
    if (role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
      const t = contentToText(m?.content).trim();
      if (!t) continue;
    }
    const text = contentToText(m?.content).trim();
    if (!text) continue;
    turns.push({ role: role === 'assistant' ? 'assistant' : 'user', text });
  }

  if (!turns.length) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const t = contentToText(messages[i]?.content).trim();
      if (t) return truncatePrompt(t);
    }
    return 'hello';
  }

  const lastUserIdx = (() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === 'user') return i;
    }
    return turns.length - 1;
  })();

  const start = Math.max(0, lastUserIdx - 2);
  const slice = turns.slice(start, lastUserIdx + 1);
  if (slice.length === 1) return truncatePrompt(slice[0].text);

  const parts = slice.map((t) =>
    t.role === 'assistant' ? `[assistant] ${t.text}` : t.text,
  );
  return truncatePrompt(parts.join('\n\n'));
}

/** @param {string} q */
function truncatePrompt(q) {
  const MAX = 12000;
  const s = String(q || '').trim();
  if (!s) return 'hello';
  if (s.length <= MAX) return s;
  return s.slice(0, MAX - 20) + '\n…[truncated]';
}

/**
 * Strip ChatGPT private-use citation / widget markers that leak into CLI.
 * Web UI renders cite… as footnotes; raw stream is U+E200…U+E201.
 * @param {string} text
 */
function sanitizeWebText(text) {
  let s = String(text || '');
  // Full cite/widget blocks: \uE200 … \uE201
  s = s.replace(/\uE200[\s\S]*?\uE201/g, '');
  // Stray private-use chars in the ChatGPT special range
  s = s.replace(/[\uE200-\uE2FF]/g, '');
  // Rare rich-text leaks if any path serializes tags
  s = s.replace(/<\/?(?:Text|Bold|Italic|Code|Link|Paragraph)(?:\s[^>]*)?>/gi, '');
  // Collapse whitespace left by stripped cites
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s;
}

/**
 * @param {any} ev
 * @returns {{ text: string, messageId: string | null, status: string, contentType: string } | null}
 */
function extractAssistantMessage(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const msg = ev.message;
  if (!msg || typeof msg !== 'object') return null;
  const role = msg.author?.role || msg.role;
  if (role && role !== 'assistant') return null;
  const content = msg.content;
  if (!content || typeof content !== 'object') return null;
  const contentType = String(content.content_type || 'text');
  // Skip intermediate code / thought blocks — only user-visible text
  if (contentType && contentType !== 'text') return null;
  const parts = content.parts;
  if (!Array.isArray(parts)) return null;
  const raw = parts
    .map((p) => {
      if (typeof p === 'string') return p;
      if (p && typeof p === 'object' && typeof p.text === 'string') return p.text;
      return '';
    })
    .filter(Boolean)
    .join('');
  return {
    text: sanitizeWebText(raw),
    messageId: msg.id ? String(msg.id) : null,
    status: String(msg.status || ''),
    contentType,
  };
}

/**
 * @param {Response} res
 */
async function collectAnswerFromSse(res) {
  const text = await res.text();
  let answer = '';
  let finished = '';
  /** @type {string | null} */
  let stickId = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const ev = JSON.parse(raw);
      const m = extractAssistantMessage(ev);
      if (!m || !m.text) continue;
      if (stickId && m.messageId && m.messageId !== stickId) continue;
      if (!stickId && m.messageId) stickId = m.messageId;
      answer = m.text;
      if (m.status === 'finished_successfully') finished = m.text;
    } catch {
      /* ignore */
    }
  }
  return finished || answer;
}

/**
 * @param {string} answer
 * @param {string} model
 */
function toChatCompletion(answer, model) {
  return {
    id: `chatcmpl_web_${Date.now()}`,
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
 * Web conversation SSE → OpenAI chat.completions SSE.
 *
 * Upstream re-sends the full `parts` snapshot each event (not token append).
 * We only emit pure prefix growth for one assistant message id. Non-prefix
 * rewrites must NOT be sliced mid-string — that produced garbage like
 * `Mình là<Text>B…` / `**GPTrên mô hình` in the CLI.
 *
 * @param {Response} upstream
 * @param {string} model
 */
function streamOpenAiFromWebSse(upstream, model) {
  const id = `chatcmpl_web_${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  let sentRole = false;
  /** Text already pushed to the client */
  let emitted = '';
  /** Latest good full snapshot (prefix-consistent with emitted when possible) */
  let latest = '';
  /** @type {string | null} stick to first assistant text message */
  let stickId = null;

  const body = new ReadableStream({
    async start(controller) {
      /**
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
        if (!sentRole) {
          pushChunk({ role: 'assistant', content: '' });
          sentRole = true;
        }
      };

      /**
       * Emit only if `full` extends what we already sent (monotonic growth).
       * @param {string} full
       */
      const emitPrefixGrowth = (full) => {
        if (!full) return;
        if (full.startsWith(emitted)) {
          const delta = full.slice(emitted.length);
          if (delta) {
            ensureRole();
            pushChunk({ content: delta });
            emitted = full;
          }
          latest = full;
          return;
        }
        // Rewrite / alternate draft: keep latest for final flush, do not splice
        if (full.length >= latest.length) latest = full;
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
            const m = extractAssistantMessage(ev);
            if (!m) continue;
            if (stickId && m.messageId && m.messageId !== stickId) continue;
            if (!stickId && m.messageId) stickId = m.messageId;

            emitPrefixGrowth(m.text);

            // On finished snapshot: if we never streamed a compatible prefix
            // (full rewrite), emit the final clean text once.
            if (m.status === 'finished_successfully' && m.text) {
              if (!emitted) {
                ensureRole();
                pushChunk({ content: m.text });
                emitted = m.text;
                latest = m.text;
              } else if (m.text.startsWith(emitted)) {
                emitPrefixGrowth(m.text);
              } else if (m.text !== emitted) {
                // Already streamed a draft that diverged — append final clean
                // version on a new paragraph so CLI isn't left with half-garbage.
                const tail = `\n\n${m.text}`;
                ensureRole();
                pushChunk({ content: tail });
                emitted += tail;
                latest = m.text;
              }
            }
          }
        }

        if (!sentRole) {
          ensureRole();
          if (latest) pushChunk({ content: latest });
        } else if (latest && latest.startsWith(emitted) && latest.length > emitted.length) {
          pushChunk({ content: latest.slice(emitted.length) });
        }
        pushChunk({}, 'stop');
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (err) {
        try {
          const msg = err instanceof Error ? err.message : String(err);
          ensureRole();
          pushChunk({ content: `\n[stream error: ${msg}]` });
          pushChunk({}, 'stop');
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch {
          controller.error(err);
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
