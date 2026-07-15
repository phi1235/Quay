/**
 * Apply local gateway settings into ~/.codex so CLI / IDE use this service
 * (same idea as Cockpit Local Access takeover).
 *
 * Also registers ChatGPT web models (chatgpt-web*) in a local model_catalog_json
 * so free accounts can: codex -m chatgpt-web
 * Pro/Edu keep using gpt-* / *-codex as usual (default model unchanged).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadState } from './store.js';

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** Web conversation models (Quay routes these to /backend-api/conversation). */
const CHATGPT_WEB_MODELS = [
  {
    slug: 'chatgpt-web',
    display_name: 'Quay · ChatGPT Web',
    description: 'Browser chat via Quay (free plan OK)',
    priority: 80,
  },
  {
    slug: 'chatgpt-web-mini',
    display_name: 'Quay · ChatGPT Web Mini',
    description: 'gpt-5-mini via ChatGPT web',
    priority: 81,
  },
  {
    slug: 'chatgpt-web-5.3',
    display_name: 'Quay · ChatGPT Web 5.3',
    description: 'gpt-5-3 via ChatGPT web',
    priority: 82,
  },
  {
    slug: 'chatgpt-web-5.5',
    display_name: 'Quay · ChatGPT Web 5.5',
    description: 'gpt-5-5 via ChatGPT web',
    priority: 83,
  },
];

const WEB_BASE_INSTRUCTIONS =
  'You are a helpful assistant. Answer clearly and concisely.';

/**
 * @param {{ port?: number, apiKey?: string, model?: string, backup?: boolean }} [opts]
 */
export function applyCodexConfig(opts = {}) {
  const state = loadState();
  const port = Number(opts.port || state.port);
  const apiKey = opts.apiKey || state.localApiKey;
  // Default stays a Codex agent model — Pro/Edu path. Free users: -m chatgpt-web
  const model = opts.model || 'gpt-5.4';
  const home = codexHome();
  fs.mkdirSync(home, { recursive: true });

  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const authPath = path.join(home, 'auth.json');
  const configPath = path.join(home, 'config.toml');
  const catalogPath = path.join(home, 'quay-model-catalog.json');

  if (opts.backup !== false) {
    backupIfExists(authPath);
    backupIfExists(configPath);
  }

  const auth = {
    auth_mode: 'apikey',
    OPENAI_API_KEY: apiKey,
  };
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 });

  writeModelCatalog(catalogPath);

  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const next = mergeConfigToml(existing, {
    model,
    baseUrl,
    apiKey,
    catalogPath,
  });
  fs.writeFileSync(configPath, next, { mode: 0o600 });

  return {
    codexHome: home,
    authPath,
    configPath,
    catalogPath,
    baseUrl,
    apiKey,
    model,
    webModels: CHATGPT_WEB_MODELS.map((m) => m.slug),
    note: 'Pro/Edu: default gpt-* (Codex). Free: codex -m chatgpt-web',
  };
}

/**
 * Build catalog = existing Codex cache models (if any) + Quay chatgpt-web*.
 * Full replace of model_catalog_json would otherwise hide gpt-5.x from the picker.
 * @param {string} catalogPath
 */
function writeModelCatalog(catalogPath) {
  const template = loadCatalogTemplate();
  /** @type {any[]} */
  let models = [];

  const cachePath = path.join(codexHome(), 'models_cache.json');
  if (fs.existsSync(cachePath)) {
    try {
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (Array.isArray(cache?.models)) models = cache.models.map((m) => ({ ...m }));
    } catch {
      /* ignore bad cache */
    }
  }

  const have = new Set(models.map((m) => m.slug));
  for (const w of CHATGPT_WEB_MODELS) {
    if (have.has(w.slug)) {
      // refresh display fields
      const hit = models.find((m) => m.slug === w.slug);
      if (hit) {
        hit.display_name = w.display_name;
        hit.description = w.description;
        hit.priority = w.priority;
      }
      continue;
    }
    models.push({
      ...template,
      slug: w.slug,
      display_name: w.display_name,
      description: w.description,
      priority: w.priority,
      default_reasoning_level: 'none',
      supported_reasoning_levels: [
        { effort: 'none', description: 'No extra reasoning' },
        { effort: 'low', description: 'Light reasoning' },
        { effort: 'medium', description: 'Balanced' },
      ],
      base_instructions: WEB_BASE_INSTRUCTIONS,
      visibility: 'list',
      supported_in_api: true,
    });
  }

  fs.writeFileSync(
    catalogPath,
    JSON.stringify({ models }, null, 2) + '\n',
    { mode: 0o600 },
  );
}

/** Minimal valid Model entry for Codex CLI catalog parser. */
function loadCatalogTemplate() {
  const cachePath = path.join(codexHome(), 'models_cache.json');
  if (fs.existsSync(cachePath)) {
    try {
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const first = cache?.models?.[0];
      if (first && typeof first === 'object') {
        const t = { ...first };
        delete t.availability_nux;
        delete t.upgrade;
        return t;
      }
    } catch {
      /* fall through */
    }
  }
  // Fallback if user never ran official Codex models list
  return {
    slug: 'placeholder',
    display_name: 'placeholder',
    description: '',
    default_reasoning_level: 'none',
    supported_reasoning_levels: [
      { effort: 'none', description: 'No extra reasoning' },
    ],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 99,
    base_instructions: WEB_BASE_INSTRUCTIONS,
    supports_reasoning_summaries: false,
    default_reasoning_summary: 'none',
    support_verbosity: false,
    default_verbosity: 'medium',
    context_window: 128000,
    max_context_window: 128000,
    effective_context_window_percent: 95,
    input_modalities: ['text'],
    supports_parallel_tool_calls: false,
    supports_image_detail_original: false,
    supports_search_tool: false,
  };
}

function backupIfExists(filePath) {
  if (!fs.existsSync(filePath)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(filePath, `${filePath}.quay-bak-${stamp}`);
}

/**
 * Minimal TOML merge: set preferred keys + quay provider block + model catalog.
 * Keeps other content as-is when possible.
 */
function mergeConfigToml(existing, { model, baseUrl, apiKey, catalogPath }) {
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
      if (t.startsWith('model_catalog_json =')) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // TOML string path — escape backslashes
  const catalogToml = String(catalogPath).replace(/\\/g, '\\\\');

  const header = [
    `model = "${model}"`,
    `preferred_auth_method = "apikey"`,
    `model_provider = "quay"`,
    // Merge official cache + chatgpt-web* so picker keeps gpt-5.x for Pro/Edu
    `model_catalog_json = "${catalogToml}"`,
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
