/**
 * Upstream Codex backend (same family as CLIProxy / Cockpit):
 *   https://chatgpt.com/backend-api/codex/responses
 */

const UPSTREAM_BASE =
  process.env.QUAY_UPSTREAM_BASE ||
  process.env.CLG_UPSTREAM_BASE ||
  'https://chatgpt.com/backend-api/codex';

const DEFAULT_UA =
  process.env.QUAY_USER_AGENT ||
  process.env.CLG_USER_AGENT ||
  'codex-tui/0.143.0 (Linux; x86_64) quay/0.1.0';

/**
 * @param {import('./store.js').Account} account
 * @param {string} path  e.g. /responses
 * @param {object} body
 * @param {{ stream?: boolean, signal?: AbortSignal }} [opts]
 */
export async function upstreamCodex(account, path, body, opts = {}) {
  const url = `${UPSTREAM_BASE.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${account.accessToken}`,
    Accept: opts.stream ? 'text/event-stream' : 'application/json',
    'User-Agent': DEFAULT_UA,
    Originator: 'codex_cli_rs',
    Connection: 'keep-alive',
    Referer: 'https://chatgpt.com/',
  };
  if (account.accountId) {
    // CLIProxy uses this casing
    headers['Chatgpt-Account-Id'] = account.accountId;
    headers['ChatGPT-Account-Id'] = account.accountId;
  }

  // ChatGPT session Codex backend: store=false, stream=true (required)
  const wantStream = opts.stream !== false;
  const payload =
    body && typeof body === 'object'
      ? { ...body, store: false, stream: true }
      : body;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...headers,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(payload),
    signal: opts.signal,
  });

  // If caller asked non-stream, collect SSE into one JSON response-like object
  if (!wantStream && res.ok) {
    const text = await res.text();
    const collected = collectSseResponse(text);
    return new Response(JSON.stringify(collected), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return res;
}

/** Minimal SSE collector for responses API */
function collectSseResponse(sseText) {
  let last = { id: `resp_quay_${Date.now()}`, object: 'response', status: 'completed', output: [] };
  let textOut = '';
  for (const line of String(sseText).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const ev = JSON.parse(raw);
      if (ev.type === 'response.completed' && ev.response) {
        last = ev.response;
      } else if (ev.type === 'response.output_text.delta' && ev.delta) {
        textOut += ev.delta;
      } else if (ev.response) {
        last = ev.response;
      }
    } catch {
      /* ignore partial */
    }
  }
  if (textOut && !last.output_text) last.output_text = textOut;
  return last;
}

/**
 * Convert OpenAI chat.completions body → Codex responses-ish body.
 */
export function chatCompletionsToResponses(body) {
  const model = body.model || 'gpt-5.6-sol';
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const input = messages.map((m) => {
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'developer' : 'user';
    let content = m.content;
    if (typeof content === 'string') {
      content = [{ type: 'input_text', text: content }];
    }
    return { role, content };
  });

  return {
    model,
    input,
    stream: Boolean(body.stream),
    store: false,
  };
}

/**
 * Map simple responses payload → chat.completions shape for non-stream.
 */
export function responsesToChatCompletion(respJson, model) {
  let text = '';
  if (typeof respJson?.output_text === 'string') text = respJson.output_text;
  else if (Array.isArray(respJson?.output)) {
    for (const item of respJson.output) {
      if (item?.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c.type === 'output_text' || c.type === 'text') text += c.text || '';
        }
      }
    }
  } else if (respJson?.choices?.[0]?.message?.content) {
    text = respJson.choices[0].message.content;
  }

  return {
    id: respJson?.id || `chatcmpl_quay_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || respJson?.model || 'gpt-5.6-sol',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text || JSON.stringify(respJson) },
        finish_reason: 'stop',
      },
    ],
    usage: respJson?.usage || undefined,
  };
}

export function defaultModels() {
  // Codex agent + ChatGPT web chat + Grok + Perplexity
  const codex = [
    'gpt-5.6-sol',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.3-codex',
    'gpt-5.2',
    'gpt-5.1-codex',
    'o4-mini',
    'o3',
  ].map((id) => ({ id, object: 'model', created: 0, owned_by: 'codex' }));

  // Browser chat path (free plan OK) — same JWT pool as codex
  const chatgptWeb = [
    'chatgpt-web',
    'chatgpt-web-mini',
    'chatgpt-web-5.3',
    'chatgpt-web-5.5',
  ].map((id) => ({ id, object: 'model', created: 0, owned_by: 'chatgpt-web' }));

  // Grok CLI surface: 4.5 (chat) + grok-build (coding default)
  const grok = ['grok-4.5', 'grok-build'].map((id) => ({
    id,
    object: 'model',
    created: 0,
    owned_by: 'xai',
  }));

  const pplx = [
    'pplx-pro',
    'pplx-turbo',
    'pplx-sonar',
    'pplx-gpt-5.6-terra',
    'pplx-gemini',
    'pplx-claude-sonnet',
    'pplx-glm',
    'pplx-kimi',
    'pplx-grok',
    'pplx-nemotron',
    'sonar',
  ].map((id) => ({ id, object: 'model', created: 0, owned_by: 'perplexity' }));

  return {
    object: 'list',
    data: [...codex, ...chatgptWeb, ...grok, ...pplx],
  };
}

/** statuses where trying another pool account makes sense */
export function isRetryableUpstreamStatus(status) {
  // 402: payment / deactivated workspace (ChatGPT k12, etc.)
  return (
    status === 401 ||
    status === 402 ||
    status === 403 ||
    status === 429 ||
    status === 503
  );
}

/**
 * Longer skip for permanent-looking auth/workspace failures.
 * @param {number} status
 * @param {string} [body]
 */
export function cooldownMsForUpstream(status, body = '') {
  const text = String(body || '');
  if (
    status === 402 ||
    /deactivated_workspace|workspace_deactivated|account_deactivated/i.test(text)
  ) {
    // workspace chết — đừng spam lại trong 30 phút
    return 30 * 60_000;
  }
  if (status === 401 || status === 403) {
    return 5 * 60_000;
  }
  // Cloudflare HTML challenge / rate limit — longer cool-down so UI stops spam-502s
  if (
    status === 429 ||
    /just a moment|cloudflare|cf-ray|attention required/i.test(text)
  ) {
    return 90_000;
  }
  return 120_000;
}
