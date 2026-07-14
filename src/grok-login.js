/**
 * Interactive Grok OIDC login for Quay multi-account vault.
 *
 * Loopback + PKCE + prompt=login|select_account so popup asks for a
 * NEW account instead of silently reusing the browser SSO session.
 *
 * Does NOT write ~/.grok/auth.json — only Quay vault + accounts store.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import { mergeIntoVault, importFromVault } from './import-grok.js';

const CLIENT_ID =
  process.env.QUAY_GROK_CLIENT_ID || 'b1a00492-073a-47ea-816f-4c329264a828';

const AUTH_URL =
  process.env.QUAY_GROK_AUTH_URL || 'https://auth.x.ai/oauth2/authorize';

const TOKEN_URL =
  process.env.QUAY_GROK_TOKEN_URL || 'https://auth.x.ai/oauth2/token';

const USERINFO_URL =
  process.env.QUAY_GROK_USERINFO_URL || 'https://auth.x.ai/oauth2/userinfo';

const SCOPE =
  process.env.QUAY_GROK_SCOPES ||
  'openid profile email offline_access grok-cli:access api:access conversations:read conversations:write';

/** @type {Map<string, LoginSession>} */
const sessions = new Map();

/**
 * @typedef {{
 *  id: string,
 *  status: 'pending' | 'ok' | 'error' | 'expired',
 *  createdAt: number,
 *  expiresAt: number,
 *  codeVerifier: string,
 *  state: string,
 *  redirectUri: string,
 *  verificationUriComplete: string,
 *  authorizeUrl?: string,
 *  userCode?: string,
 *  verificationUri?: string,
 *  error?: string,
 *  email?: string,
 *  importedCount?: number,
 *  server?: http.Server,
 * }} LoginSession
 */

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Start loopback OIDC login. Open verificationUriComplete in browser popup.
 * Uses prompt=login select_account so user can pick / sign in a different account.
 */
export async function startGrokDeviceLogin() {
  const { verifier, challenge } = pkcePair();
  const state = b64url(crypto.randomBytes(16));
  const id = crypto.randomBytes(8).toString('hex');

  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(null));
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  /** @type {LoginSession} */
  const session = {
    id,
    status: 'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + 15 * 60 * 1000,
    codeVerifier: verifier,
    state,
    redirectUri,
    verificationUriComplete: '',
    server,
  };

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // Ép re-auth; browser SSO vẫn có thể hiện consent — user bấm Sign out trên trang đó
    prompt: 'login',
    max_age: '0',
  });
  const authorizeUrl = `${AUTH_URL}?${params.toString()}`;
  // Mở trang hướng dẫn local trước (không nhảy thẳng consent acc cũ)
  session.verificationUriComplete = `http://127.0.0.1:${port}/start`;
  session.verificationUri = authorizeUrl;
  session.userCode = '';
  session.authorizeUrl = authorizeUrl;

  sessions.set(id, session);

  server.on('request', (req, res) => {
    const path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (path === '/start' || path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(startPage(authorizeUrl));
      return;
    }
    handleCallback(session, req, res).catch((err) => {
      session.status = 'error';
      session.error = err instanceof Error ? err.message : String(err);
      try {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlPage('Lỗi', session.error, false));
      } catch {
        /* ignore */
      }
      closeServer(session);
    });
  });

  // timeout
  setTimeout(() => {
    if (session.status === 'pending') {
      session.status = 'expired';
      session.error = 'Hết hạn đăng nhập — thử lại';
      closeServer(session);
    }
  }, 15 * 60 * 1000).unref?.();

  // cleanup old
  for (const [k, s] of sessions) {
    if (s.status !== 'pending' && Date.now() - s.createdAt > 30 * 60 * 1000) {
      closeServer(s);
      sessions.delete(k);
    }
  }

  return publicLoginSession(session);
}

/**
 * @param {string} id
 */
export function getGrokLoginStatus(id) {
  const s = sessions.get(id);
  if (!s) {
    return { id, status: 'error', error: 'Phiên login không tồn tại hoặc đã hết' };
  }
  if (s.status === 'pending' && Date.now() > s.expiresAt) {
    s.status = 'expired';
    s.error = 'Hết hạn đăng nhập — thử lại';
    closeServer(s);
  }
  return publicLoginSession(s);
}

/**
 * @param {LoginSession} session
 */
function publicLoginSession(session) {
  return {
    id: session.id,
    status: session.status,
    userCode: session.userCode || null,
    verificationUri: session.verificationUri || null,
    verificationUriComplete: session.verificationUriComplete,
    expiresAt: new Date(session.expiresAt).toISOString(),
    error: session.error || null,
    email: session.email || null,
    importedCount: session.importedCount ?? null,
    note: 'Popup login acc mới → chỉ lưu Quay vault. Không đổi ~/.grok/auth.json hay web session.',
  };
}

/**
 * @param {LoginSession} session
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleCallback(session, req, res) {
  const url = new URL(req.url || '/', `http://127.0.0.1`);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end('Not found');
    return;
  }

  if (session.status !== 'pending') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlPage('Xong', 'Bạn có thể đóng cửa sổ này.', true));
    return;
  }

  const err = url.searchParams.get('error');
  if (err) {
    session.status = 'error';
    session.error = url.searchParams.get('error_description') || err;
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlPage('Đăng nhập thất bại', session.error, false));
    closeServer(session);
    return;
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || state !== session.state) {
    session.status = 'error';
    session.error = 'State/code không hợp lệ';
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlPage('Lỗi', session.error, false));
    closeServer(session);
    return;
  }

  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: session.redirectUri,
    client_id: CLIENT_ID,
    code_verifier: session.codeVerifier,
  });

  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': 'quay/0.1.0',
    },
    body: tokenBody,
  });
  const tokenText = await tokenRes.text();
  if (!tokenRes.ok) {
    session.status = 'error';
    session.error = `Token exchange ${tokenRes.status}: ${tokenText.slice(0, 200)}`;
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlPage('Lỗi token', session.error, false));
    closeServer(session);
    return;
  }

  const data = JSON.parse(tokenText);
  const accessToken = data.access_token;
  if (!accessToken) {
    session.status = 'error';
    session.error = 'Thiếu access_token';
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlPage('Lỗi', session.error, false));
    closeServer(session);
    return;
  }

  const claims = decodeJwt(accessToken) || {};
  const email =
    (await fetchUserEmail(accessToken)) ||
    claims.email ||
    `grok-${String(claims.sub || claims.principal_id || 'user').slice(0, 12)}`;

  const entry = {
    key: accessToken,
    refresh_token: data.refresh_token || null,
    auth_mode: 'oidc',
    email: String(email),
    user_id: claims.sub || claims.principal_id || null,
    principal_id: claims.principal_id || claims.sub || null,
    team_id: claims.team_id || null,
    oidc_client_id: CLIENT_ID,
    oidc_issuer: 'https://auth.x.ai',
    expires_at:
      typeof data.expires_in === 'number'
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : claims.exp
          ? new Date(claims.exp * 1000).toISOString()
          : null,
    // tier có thể là number — luôn stringify
    subscription_tier:
      claims.tier != null
        ? String(claims.tier)
        : claims.subscription_tier != null
          ? String(claims.subscription_tier)
          : 'grok',
  };

  mergeIntoVault([entry]);
  const imported = importFromVault();

  session.status = 'ok';
  session.email = String(email);
  session.importedCount = imported.length;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    htmlPage(
      'Đã thêm vào Quay',
      `Account <b>${escapeHtml(String(email))}</b> đã lưu vào vault.<br/>Có thể đóng cửa sổ này — Grok CLI / web login không bị đổi.`,
      true,
    ),
  );
  closeServer(session);
}

/**
 * @param {LoginSession} session
 */
function closeServer(session) {
  if (session.server) {
    try {
      session.server.close();
    } catch {
      /* ignore */
    }
    session.server = undefined;
  }
}

function startPage(authorizeUrl) {
  const href = escapeHtml(authorizeUrl);
  return `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"/><title>Quay · Thêm Grok</title>
<style>
body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f4f6f9;color:#0f172a}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:28px 28px 24px;max-width:440px;box-shadow:0 8px 24px rgba(15,23,42,.06)}
h1{font-size:1.1rem;margin:0 0 8px}
.lead{margin:0 0 16px;color:#64748b;font-size:.9rem;line-height:1.5}
ol{margin:0 0 18px;padding-left:1.2rem;color:#334155;font-size:.9rem;line-height:1.55}
li{margin:6px 0}
.note{background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:10px 12px;font-size:.82rem;color:#1e40af;margin-bottom:16px;line-height:1.45}
.btn{display:inline-flex;align-items:center;justify-content:center;width:100%;height:42px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-weight:700;font-size:.92rem;text-decoration:none;cursor:pointer}
.btn:hover{background:#1d4ed8}
.sub{margin:12px 0 0;text-align:center;font-size:.78rem;color:#94a3b8}
</style></head><body><div class="card">
<h1>Thêm account Grok vào Quay</h1>
<p class="lead">Popup chỉ lấy token cho <b>Quay</b>. Grok CLI / web đang login <b>không bị thay</b>.</p>
<div class="note">
  Nếu trang xAI hiện <b>Signed in as …</b> (acc cũ): bấm <b>Sign out</b> góc trên → login acc <b>mới</b> → rồi <b>Authorize</b>.
</div>
<ol>
  <li>Bấm nút bên dưới → trang xAI</li>
  <li>Thấy acc cũ → <b>Sign out</b> → đăng nhập acc khác</li>
  <li>Authorize Grok Build → đóng popup khi báo thành công</li>
</ol>
<a class="btn" href="${href}">Tiếp tục đăng nhập xAI</a>
<p class="sub">Quay vault lưu nhiều acc · không ghi ~/.grok/auth.json</p>
</div></body></html>`;
}

function htmlPage(title, body, ok) {
  const color = ok ? '#059669' : '#dc2626';
  return `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f4f6f9;color:#0f172a}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px 32px;max-width:400px;text-align:center;box-shadow:0 8px 24px rgba(15,23,42,.06)}
h1{font-size:1.15rem;margin:0 0 10px;color:${color}}
p{margin:0;color:#64748b;font-size:.92rem;line-height:1.5}
</style></head><body><div class="card"><h1>${escapeHtml(title)}</h1><p>${body}</p></div>
<script>setTimeout(function(){try{window.close()}catch(e){}},2800)</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function fetchUserEmail(accessToken) {
  try {
    const res = await fetch(USERINFO_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'quay/0.1.0',
      },
    });
    if (!res.ok) return null;
    const u = await res.json();
    return u.email || u.preferred_username || null;
  } catch {
    return null;
  }
}

function decodeJwt(token) {
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
