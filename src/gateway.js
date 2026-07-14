import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadState,
  pickAccount,
  listPoolAccounts,
  touchAccount,
  cooldownAccount,
} from './store.js';
import {
  upstreamCodex,
  chatCompletionsToResponses,
  responsesToChatCompletion,
  defaultModels,
  isRetryableUpstreamStatus,
} from './upstream.js';
import {
  upstreamGrokChat,
  responsesBodyToChatCompletions,
  chatCompletionToResponses,
  inferProvider,
  resolveGrokModel,
} from './upstream-grok.js';
import { pushRequestLog } from './request-log.js';
import { mountAdminApi } from './api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');

/**
 * @param {{ silent?: boolean }} [opts]
 */
export function createApp(opts = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '30mb' }));

  mountAdminApi(app);
  // UI assets: luôn lấy bản mới (tránh cache app.js/styles.css cũ)
  app.use(
    express.static(PUBLIC_DIR, {
      etag: false,
      lastModified: false,
      setHeaders(res, filePath) {
        if (/\.(html?|js|css)$/i.test(filePath)) {
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
          res.setHeader('Pragma', 'no-cache');
        }
      },
    }),
  );

  app.get('/health', (_req, res) => {
    const state = loadState();
    const pool = listPoolAccounts();
    res.json({
      ok: true,
      service: 'quay',
      port: state.port,
      poolSize: pool.length,
      routing: state.routing,
    });
  });

  app.use('/v1', authMiddleware);

  app.get('/v1/models', (_req, res) => {
    res.json(defaultModels());
  });

  app.post('/v1/responses', async (req, res) => {
    await proxyWithFailover(req, res, '/responses', (body) => body);
  });

  app.post('/v1/responses/compact', async (req, res) => {
    await proxyWithFailover(req, res, '/responses/compact', (body) => body, {
      forceNoStream: true,
    });
  });

  app.post('/v1/chat/completions', async (req, res) => {
    await proxyWithFailover(req, res, '/responses', chatCompletionsToResponses, {
      asChatCompletions: true,
    });
  });

  app.use('/v1', async (req, res, next) => {
    if (res.headersSent) return next();
    if (req.method === 'GET') {
      res.status(404).json({
        error: {
          message: `Unsupported path ${req.originalUrl}. Use /v1/models, /v1/responses, /v1/chat/completions`,
        },
      });
      return;
    }
    const suffix = req.path.startsWith('/') ? req.path : `/${req.path}`;
    await proxyWithFailover(req, res, suffix, (body) => body || {});
  });

  if (!opts.silent) {
    console.log('[gateway] routes ready');
  }
  return app;
}

function authMiddleware(req, res, next) {
  const state = loadState();
  const header = req.headers.authorization || '';
  const key = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : String(req.headers['x-api-key'] || '').trim();

  // also accept experimental_bearer_token from config if client sends it as bearer
  if (!key || key !== state.localApiKey) {
    res.status(401).json({
      error: {
        message: 'Invalid local API key. Copy key from UI / Dịch vụ API.',
        type: 'invalid_api_key',
      },
    });
    return;
  }
  next();
}

/**
 * Sticky key so multi-turn / reconnects stay on same upstream account.
 */
function stickyKeyFrom(req, body) {
  return (
    req.headers['x-session-id'] ||
    req.headers['session_id'] ||
    req.headers['conversation_id'] ||
    body?.conversation_id ||
    body?.session_id ||
    body?.previous_response_id ||
    null
  );
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} upstreamPath
 * @param {(body: any) => any} mapBody
 * @param {{ forceNoStream?: boolean, asChatCompletions?: boolean }} [opts]
 */
async function proxyWithFailover(req, res, upstreamPath, mapBody, opts = {}) {
  const body = req.body || {};
  const stream = opts.forceNoStream ? false : Boolean(body.stream);
  const stickyKey = stickyKeyFrom(req, body);
  const provider = opts.provider || inferProvider(body.model, req);
  const exclude = new Set();
  const providerPool = listPoolAccounts().filter(
    (a) => (a.provider || 'codex') === provider,
  );
  const poolSize = Math.max(1, providerPool.length);
  let lastStatus = 502;
  let lastBody = JSON.stringify({
    error: {
      message:
        providerPool.length === 0
          ? `No ${provider} accounts in pool. Import + add to pool first.`
          : 'upstream failed',
      type: providerPool.length === 0 ? 'no_pool_account' : 'upstream_error',
      provider,
    },
  });

  const reqModel = body.model || null;

  for (let attempt = 0; attempt < poolSize; attempt++) {
    const account = pickAccount({ stickyKey, excludeIds: exclude, provider });
    if (!account) break;

    exclude.add(account.id);
    const t0 = Date.now();
    const accProvider = account.provider === 'grok' ? 'grok' : 'codex';
    const logBase = {
      provider: accProvider,
      accountId: account.id,
      email: account.email,
      model:
        accProvider === 'grok' ? resolveGrokModel(reqModel) : reqModel || null,
      path: upstreamPath,
      stream,
    };

    try {
      touchAccount(account.id, { lastError: null });

      /** @type {Response} */
      let upstream;
      /** @type {'chat' | 'responses'} */
      let upstreamKind = 'responses';

      if (accProvider === 'grok') {
        // Grok: native OpenAI chat.completions on api.x.ai
        const chatBody =
          opts.asChatCompletions || upstreamPath.includes('chat')
            ? { ...body, stream }
            : responsesBodyToChatCompletions({ ...mapBody(body), stream });
        if (opts.forceNoStream) chatBody.stream = false;
        // 1 retry cùng acc khi lỗi mạng (tránh failover + RTT gấp đôi)
        try {
          upstream = await upstreamGrokChat(account, chatBody, {
            stream: Boolean(chatBody.stream),
          });
        } catch (netErr) {
          const msg = netErr instanceof Error ? netErr.message : String(netErr);
          if (/fetch failed|ECONNRESET|ETIMEDOUT|network/i.test(msg) && attempt === 0) {
            console.warn(
              `[gateway] grok account=${account.email} ${msg} → retry once`,
            );
            upstream = await upstreamGrokChat(account, chatBody, {
              stream: Boolean(chatBody.stream),
            });
          } else {
            throw netErr;
          }
        }
        upstreamKind = 'chat';
      } else {
        const mapped = mapBody(body);
        upstream = await upstreamCodex(account, upstreamPath, mapped, { stream });
        upstreamKind = 'responses';
      }

      // Retry other accounts BEFORE writing response when auth/rate-limit fails
      if (isRetryableUpstreamStatus(upstream.status) && attempt < poolSize - 1) {
        const errText = await upstream.text().catch(() => '');
        lastStatus = upstream.status;
        lastBody = errText || lastBody;
        cooldownAccount(
          account.id,
          `upstream ${upstream.status}: ${errText.slice(0, 180)}`,
          upstream.status === 429 ? 60_000 : 120_000,
        );
        pushRequestLog({
          ...logBase,
          status: upstream.status,
          ms: Date.now() - t0,
          ok: false,
          error: `failover ${upstream.status}`,
        });
        console.warn(
          `[gateway] ${accProvider} account=${account.email} status=${upstream.status} ${Date.now() - t0}ms → failover`,
        );
        continue;
      }

      // non-stream chat.completions client
      if (opts.asChatCompletions && !stream) {
        const text = await upstream.text();
        if (!upstream.ok) {
          pushRequestLog({
            ...logBase,
            status: upstream.status,
            ms: Date.now() - t0,
            ok: false,
            error: text.slice(0, 160),
          });
          res.status(upstream.status).type('application/json').send(text);
          if (isRetryableUpstreamStatus(upstream.status)) {
            cooldownAccount(account.id, text.slice(0, 180));
          }
          return;
        }
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          pushRequestLog({
            ...logBase,
            status: 502,
            ms: Date.now() - t0,
            ok: false,
            error: 'Invalid upstream JSON',
          });
          res.status(502).json({ error: { message: 'Invalid upstream JSON', body: text } });
          return;
        }
        // Grok already returns chat.completions; Codex returns responses-ish
        if (upstreamKind === 'chat') {
          res.json(json);
        } else {
          res.json(responsesToChatCompletion(json, body.model));
        }
        pushRequestLog({
          ...logBase,
          status: 200,
          ms: Date.now() - t0,
          ok: true,
        });
        console.log(
          `[gateway] ok ${accProvider} account=${account.email} chat ${Date.now() - t0}ms`,
        );
        return;
      }

      // non-stream /v1/responses client hitting Grok → reshape to responses
      if (
        accProvider === 'grok' &&
        !stream &&
        !opts.asChatCompletions &&
        upstreamPath.includes('responses')
      ) {
        const text = await upstream.text();
        if (!upstream.ok) {
          pushRequestLog({
            ...logBase,
            status: upstream.status,
            ms: Date.now() - t0,
            ok: false,
            error: text.slice(0, 160),
          });
          res.status(upstream.status).type('application/json').send(text);
          return;
        }
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          pushRequestLog({
            ...logBase,
            status: 502,
            ms: Date.now() - t0,
            ok: false,
            error: 'Invalid Grok JSON',
          });
          res.status(502).json({ error: { message: 'Invalid Grok JSON', body: text } });
          return;
        }
        res.json(chatCompletionToResponses(json, body.model));
        pushRequestLog({
          ...logBase,
          status: 200,
          ms: Date.now() - t0,
          ok: true,
        });
        console.log(
          `[gateway] ok grok account=${account.email} responses ${Date.now() - t0}ms`,
        );
        return;
      }

      pushRequestLog({
        ...logBase,
        status: upstream.status,
        ms: Date.now() - t0,
        ok: upstream.ok,
      });
      await pipeUpstream(upstream, res, stream);
      console.log(
        `[gateway] ok ${accProvider} account=${account.email} path=${upstreamPath} status=${upstream.status} ${Date.now() - t0}ms stream=${stream}`,
      );
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cooldownAccount(account.id, msg, 30_000);
      pushRequestLog({
        ...logBase,
        status: null,
        ms: Date.now() - t0,
        ok: false,
        error: msg,
      });
      lastBody = JSON.stringify({
        error: { message: msg, type: 'upstream_network_error', provider: accProvider },
      });
      console.warn(`[gateway] ${accProvider} account=${account.email} error=${msg} → failover`);
    }
  }

  if (!res.headersSent) {
    pushRequestLog({
      provider,
      model: reqModel,
      path: upstreamPath,
      stream,
      status: lastStatus,
      ok: false,
      error: 'all pool accounts failed',
      ms: 0,
    });
    res.status(lastStatus).type('application/json').send(lastBody);
  }
}

/**
 * @param {import('undici').Response} upstream
 * @param {import('express').Response} res
 * @param {boolean} stream
 */
async function pipeUpstream(upstream, res, stream) {
  res.status(upstream.status);
  const ct = upstream.headers.get('content-type');
  if (ct) res.setHeader('Content-Type', ct);

  if (stream && upstream.body) {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    // flush headers early so client sees stream start
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise((r) => res.once('drain', r));
        }
      }
    } finally {
      res.end();
    }
    return;
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  res.send(buf);
}

/**
 * @param {{ host?: string, port?: number }} [opts]
 */
export async function startGateway(opts = {}) {
  const state = loadState();
  const host = opts.host || state.host || '127.0.0.1';
  const port = Number(opts.port || state.port || 43690);
  const app = createApp();

  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      // shorter timeouts hurt long codex agent runs — keep generous
      server.keepAliveTimeout = 120_000;
      server.headersTimeout = 125_000;
      server.requestTimeout = 0; // disable request timeout for long agent tasks
      const ui = `http://${host}:${port}/`;
      console.log(`[gateway] UI:      ${ui}`);
      console.log(`[gateway] API:     http://${host}:${port}/v1`);
      console.log(`[gateway] API key: ${state.localApiKey}`);
      console.log(`[gateway] pool:    ${listPoolAccounts().length} account(s)`);
      console.log(`[gateway] routing: ${state.routing} (sticky keeps multi-turn on one account)`);
      resolve({ server, host, port, apiKey: state.localApiKey, ui });
    });
  });
}
