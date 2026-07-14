/**
 * Apply local gateway settings into ~/.codex so CLI / IDE use this service
 * (same idea as Cockpit Local Access takeover).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadState } from './store.js';

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/**
 * @param {{ port?: number, apiKey?: string, model?: string, backup?: boolean }} [opts]
 */
export function applyCodexConfig(opts = {}) {
  const state = loadState();
  const port = Number(opts.port || state.port);
  const apiKey = opts.apiKey || state.localApiKey;
  const model = opts.model || 'gpt-5.1';
  const home = codexHome();
  fs.mkdirSync(home, { recursive: true });

  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const authPath = path.join(home, 'auth.json');
  const configPath = path.join(home, 'config.toml');

  if (opts.backup !== false) {
    backupIfExists(authPath);
    backupIfExists(configPath);
  }

  const auth = {
    auth_mode: 'apikey',
    OPENAI_API_KEY: apiKey,
  };
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 });

  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const next = mergeConfigToml(existing, {
    model,
    baseUrl,
    apiKey,
  });
  fs.writeFileSync(configPath, next, { mode: 0o600 });

  return {
    codexHome: home,
    authPath,
    configPath,
    baseUrl,
    apiKey,
    model,
  };
}

function backupIfExists(filePath) {
  if (!fs.existsSync(filePath)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(filePath, `${filePath}.quay-bak-${stamp}`);
}

/**
 * Minimal TOML merge: set preferred keys + quay provider block.
 * Keeps other content as-is when possible.
 */
function mergeConfigToml(existing, { model, baseUrl, apiKey }) {
  const lines = existing ? existing.split(/\r?\n/) : [];
  // strip legacy clg + current quay blocks
  let withoutProvider = stripProviderBlock(lines, 'quay');
  withoutProvider = stripProviderBlock(withoutProvider, 'codex_local_access');
  const cleaned = withoutProvider
    .filter((line) => {
      const t = line.trim();
      if (t.startsWith('model =')) return false;
      if (t.startsWith('model_provider =')) return false;
      if (t.startsWith('preferred_auth_method =')) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const header = [
    `model = "${model}"`,
    `preferred_auth_method = "apikey"`,
    `model_provider = "quay"`,
    '',
    `[model_providers.quay]`,
    `name = "Quay"`,
    `base_url = "${baseUrl}"`,
    `wire_api = "responses"`,
    `requires_openai_auth = true`,
    `experimental_bearer_token = "${apiKey}"`,
    `supports_websockets = false`,
    '',
  ].join('\n');

  return `${header}${cleaned ? cleaned + '\n' : ''}`;
}

function stripProviderBlock(lines, providerId) {
  const start = `[model_providers.${providerId}]`;
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const t = line.trim();
    if (t === start) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (t.startsWith('[') && t.endsWith(']')) {
        skipping = false;
        out.push(line);
      }
      continue;
    }
    out.push(line);
  }
  return out;
}

export function printEnvExport() {
  const state = loadState();
  const baseUrl = `http://127.0.0.1:${state.port}/v1`;
  return [
    `export OPENAI_BASE_URL="${baseUrl}"`,
    `export OPENAI_API_KEY="${state.localApiKey}"`,
  ].join('\n');
}
