/**
 * Admin REST API for the web UI (local-only; bind 127.0.0.1).
 */

import {
  loadState,
  saveState,
  addToPool,
  removeFromPool,
  deleteAccount,
  setAccountPin,
  setRouting,
  regenerateLocalApiKey,
  publicStatus,
  publicAccount,
  saveAccountQuota,
  saveAccountQuotaError,
  normalizeProvider,
  patchAccount,
  clearAccountCooldown,
} from './store.js';
import { importTokenInput } from './import-json.js';
import {
  importGrokLogin,
  importGrokFromText,
  looksLikeGrokAuth,
  defaultGrokAuthPath,
  vaultStats,
} from './import-grok.js';
import {
  importPerplexityFromText,
  looksLikePerplexityCookies,
  refreshPerplexityProfile,
} from './import-perplexity.js';
import { startGrokDeviceLogin, getGrokLoginStatus } from './grok-login.js';
import { applyCodexConfig, printEnvExport } from './apply-codex.js';
import { applyGrokConfig, printGrokEnvExport } from './apply-grok.js';
import { fetchAccountQuota } from './quota.js';
import {
  listRequestLogs,
  clearRequestLogs,
  lastUsedByAccount,
} from './request-log.js';

/**
 * @param {import('express').Express} app
 */
export function mountAdminApi(app) {
  app.get('/api/status', (_req, res) => {
    res.json(publicStatus());
  });

  app.get('/api/logs', (req, res) => {
    const limit = Number(req.query.limit) || 80;
    res.json({
      logs: listRequestLogs(limit),
      lastUsed: lastUsedByAccount(),
    });
  });

  app.delete('/api/logs', (_req, res) => {
    clearRequestLogs();
    res.json({ ok: true, logs: [] });
  });

  app.get('/api/accounts', (_req, res) => {
    const state = loadState();
    res.json({
      accounts: state.accounts.map((a) => publicAccount(a, state.poolAccountIds)),
      poolAccountIds: state.poolAccountIds,
    });
  });

  /** Import from pasted JSON — auto-detect Grok / Perplexity cookies / Codex token */
  app.post('/api/import', async (req, res) => {
    try {
      const text = req.body?.text ?? req.body?.json ?? '';
      if (!String(text).trim()) {
        res.status(400).json({ error: 'Thiếu nội dung JSON (field: text)' });
        return;
      }
      const autoPool = req.body?.autoPool !== false;

      let imported;
      let provider = 'codex';
      // Grok auth.json paste?
      try {
        const parsed = JSON.parse(String(text));
        if (looksLikeGrokAuth(parsed)) {
          imported = importGrokFromText(String(text));
          provider = 'grok';
        } else if (looksLikePerplexityCookies(parsed)) {
          imported = await importPerplexityFromText(String(text));
          provider = 'perplexity';
        }
      } catch (err) {
        // rethrow if already recognized as pplx parse error
        if (err instanceof Error && /Perplexity|cookie/i.test(err.message)) {
          throw err;
        }
        /* not JSON / not grok — fall through */
      }
      // raw cookie header string
      if (!imported && looksLikePerplexityCookies(String(text))) {
        imported = await importPerplexityFromText(String(text));
        provider = 'perplexity';
      }
      if (!imported) {
        imported = importTokenInput(String(text));
      }

      if (autoPool) {
        for (const a of imported) addToPool(a.id);
      }
      // best-effort quota fetch after import (Codex only)
      for (const a of imported) {
        try {
          const full = loadState().accounts.find((x) => x.id === a.id);
          if (!full || normalizeProvider(full.provider) !== 'codex') continue;
          const quota = await fetchAccountQuota(full);
          saveAccountQuota(full.id, quota);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          try {
            saveAccountQuotaError(a.id, msg);
          } catch {
            /* ignore */
          }
        }
      }
      const state = loadState();
      res.json({
        ok: true,
        provider,
        vault: provider === 'grok' ? vaultStats() : undefined,
        imported: imported.map((a) => {
          const fresh = state.accounts.find((x) => x.id === a.id) || a;
          return publicAccount(fresh, state.poolAccountIds);
        }),
        count: imported.length,
        autoPool,
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Import current `grok login` (~/.grok/auth.json) into multi-account vault.
   * Prefer /api/import-grok/login/start for popup login (không đụng CLI session).
   */
  app.post('/api/import-grok', (req, res) => {
    try {
      const autoPool = req.body?.autoPool !== false;
      const authPath = req.body?.path ? String(req.body.path) : undefined;
      const text = req.body?.text ? String(req.body.text) : '';

      let imported;
      let source;
      if (text.trim()) {
        imported = importGrokFromText(text);
        source = 'pasted-json';
      } else {
        imported = importGrokLogin(authPath);
        source = authPath || defaultGrokAuthPath();
      }

      if (autoPool) {
        for (const a of imported) addToPool(a.id);
      }
      const state = loadState();
      const vault = vaultStats();
      res.json({
        ok: true,
        provider: 'grok',
        source,
        vault,
        imported: imported.map((a) => {
          const fresh = state.accounts.find((x) => x.id === a.id) || a;
          return publicAccount(fresh, state.poolAccountIds);
        }),
        count: imported.length,
        autoPool,
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Start Grok device login popup — does NOT touch ~/.grok/auth.json */
  app.post('/api/import-grok/login/start', async (req, res) => {
    try {
      const session = await startGrokDeviceLogin();
      res.json({ ok: true, ...session, autoPool: req.body?.autoPool !== false });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Poll device login status; when ok, accounts already in vault */
  app.get('/api/import-grok/login/:id', (req, res) => {
    const st = getGrokLoginStatus(req.params.id);
    if (st.status === 'ok') {
      // ensure all vault accounts in pool if requested via query
      const autoPool = req.query.autoPool !== '0';
      if (autoPool) {
        const state = loadState();
        for (const a of state.accounts) {
          if (a.provider === 'grok') addToPool(a.id);
        }
      }
      res.json({
        ...st,
        vault: vaultStats(),
        statusFull: publicStatus(),
      });
      return;
    }
    res.json(st);
  });

  app.post('/api/accounts/:id/pool', (req, res) => {
    try {
      const join = req.body?.join !== false;
      if (join) addToPool(req.params.id);
      else removeFromPool(req.params.id);
      res.json(publicStatus());
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Pin account as preferred for first / sticky fallback (1 pin / provider) */
  app.post('/api/accounts/:id/pin', (req, res) => {
    try {
      const pin = req.body?.pin !== false;
      setAccountPin(req.params.id, pin);
      res.json(publicStatus());
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/pool/add-all', (_req, res) => {
    const state = loadState();
    for (const a of state.accounts) addToPool(a.id);
    res.json(publicStatus());
  });

  app.post('/api/accounts/:id/enabled', (req, res) => {
    try {
      const state = loadState();
      const acc = state.accounts.find((a) => a.id === req.params.id);
      if (!acc) {
        res.status(404).json({ error: 'Không tìm thấy account' });
        return;
      }
      acc.enabled = Boolean(req.body?.enabled);
      saveState(state);
      res.json(publicStatus());
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Clear temporary cooldown (e.g. after Cloudflare 429). */
  app.post('/api/accounts/:id/clear-cooldown', (req, res) => {
    try {
      const acc = clearAccountCooldown(req.params.id);
      if (!acc) {
        res.status(404).json({ error: 'Không tìm thấy account' });
        return;
      }
      res.json(publicStatus());
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/accounts/:id', (req, res) => {
    try {
      deleteAccount(req.params.id);
      res.json(publicStatus());
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/settings/routing', (req, res) => {
    try {
      setRouting(String(req.body?.routing || ''));
      res.json(publicStatus());
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/settings/regen-key', (_req, res) => {
    regenerateLocalApiKey();
    res.json(publicStatus());
  });

  app.post('/api/apply-codex', (req, res) => {
    try {
      const result = applyCodexConfig({
        backup: req.body?.backup !== false,
        model: req.body?.model,
      });
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/apply-grok', (req, res) => {
    try {
      const result = applyGrokConfig({
        backup: req.body?.backup !== false,
        setDefault: req.body?.setDefault !== false,
      });
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/env', (_req, res) => {
    res
      .type('text/plain')
      .send(printEnvExport() + '\n\n' + printGrokEnvExport() + '\n');
  });

  /** Refresh quota for one account */
  app.post('/api/accounts/:id/quota', async (req, res) => {
    try {
      const state = loadState();
      const acc = state.accounts.find((a) => a.id === req.params.id);
      if (!acc) {
        res.status(404).json({ error: 'Không tìm thấy account' });
        return;
      }
      const prov = normalizeProvider(acc.provider);
      if (prov === 'grok') {
        res.status(400).json({
          error: 'Quota web SuperGrok chưa hỗ trợ API — xem usage trên grok.com',
        });
        return;
      }
      if (prov === 'perplexity') {
        const profile = await refreshPerplexityProfile(acc);
        patchAccount(acc.id, {
          email: profile.email || acc.email,
          userId: profile.userId || acc.userId,
          planType: profile.planType || acc.planType,
          expiresAt: profile.expiresAt || acc.expiresAt,
          lastError: null,
        });
        res.json({
          ok: true,
          account: publicAccount(
            loadState().accounts.find((a) => a.id === acc.id),
            loadState().poolAccountIds,
          ),
          profile,
        });
        return;
      }
      const quota = await fetchAccountQuota(acc);
      saveAccountQuota(acc.id, quota);
      res.json({ ok: true, account: publicAccount(loadState().accounts.find((a) => a.id === acc.id), loadState().poolAccountIds), quota });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        saveAccountQuotaError(req.params.id, msg);
      } catch {
        /* ignore */
      }
      res.status(400).json({ error: msg });
    }
  });

  /** Refresh quota for all (or pool-only) accounts */
  app.post('/api/quota/refresh', async (req, res) => {
    const state = loadState();
    const onlyPool = req.body?.onlyPool === true;
    const targets = onlyPool
      ? state.accounts.filter((a) => state.poolAccountIds.includes(a.id))
      : state.accounts;

    const results = [];
    for (const acc of targets) {
      const prov = normalizeProvider(acc.provider);
      if (prov === 'grok') {
        results.push({
          id: acc.id,
          ok: false,
          skipped: true,
          error: 'Grok: xem usage trên grok.com',
        });
        continue;
      }
      if (prov === 'perplexity') {
        try {
          const profile = await refreshPerplexityProfile(acc);
          patchAccount(acc.id, {
            email: profile.email || acc.email,
            userId: profile.userId || acc.userId,
            planType: profile.planType || acc.planType,
            expiresAt: profile.expiresAt || acc.expiresAt,
            lastError: null,
          });
          results.push({ id: acc.id, ok: true, profile });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ id: acc.id, ok: false, error: msg });
        }
        continue;
      }
      try {
        const quota = await fetchAccountQuota(acc);
        saveAccountQuota(acc.id, quota);
        results.push({ id: acc.id, ok: true, quota });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
          saveAccountQuotaError(acc.id, msg);
        } catch {
          /* ignore */
        }
        results.push({ id: acc.id, ok: false, error: msg });
      }
    }
    res.json({ ok: true, results, status: publicStatus() });
  });
}
