/**
 * Point Grok CLI at Quay (OpenAI-compatible local gateway).
 *
 * IMPORTANT: TOML table keys must NOT use bare dots in the model id.
 *   BAD:  [model.quay-grok-4.5]  → parsed as nested quay-grok-4 / 5 → CLI
 *         sends model "quay-grok-4" to cli-chat-proxy.grok.com (404)
 *   GOOD: [model.quay-grok-45] with model = "grok-4.5" and base_url = Quay
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadState } from './store.js';

function grokHome() {
  return process.env.GROK_HOME || path.join(os.homedir(), '.grok');
}

/** Slugs without dots (TOML-safe) */
const MODELS = [
  {
    slug: 'quay-grok-build',
    model: 'grok-build',
    name: 'Quay · Grok Build',
    description: 'Coding via Quay multi-account pool',
  },
  {
    slug: 'quay-grok-45',
    model: 'grok-4.5',
    name: 'Quay · Grok 4.5',
    description: 'Chat via Quay multi-account pool',
  },
];

/**
 * @param {{ backup?: boolean, setDefault?: boolean }} [opts]
 */
export function applyGrokConfig(opts = {}) {
  const state = loadState();
  const port = state.port;
  const apiKey = state.localApiKey;
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const home = grokHome();
  fs.mkdirSync(home, { recursive: true });

  const configPath = path.join(home, 'config.toml');
  if (opts.backup !== false && fs.existsSync(configPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(configPath, `${configPath}.quay-bak-${stamp}`);
  }

  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const next = mergeGrokConfigToml(existing, {
    baseUrl,
    apiKey,
    setDefault: opts.setDefault !== false,
  });
  fs.writeFileSync(configPath, next, { mode: 0o600 });

  return {
    grokHome: home,
    configPath,
    baseUrl,
    apiKey,
    models: MODELS.map((m) => m.slug),
    defaultModel: opts.setDefault !== false ? 'quay-grok-build' : null,
    note: 'Chọn model Quay · Grok Build / Quay · Grok 4.5 (slug quay-grok-build | quay-grok-45). Restart grok CLI.',
  };
}

/**
 * Strip previous Quay-managed blocks and inject fresh ones.
 */
function mergeGrokConfigToml(existing, { baseUrl, apiKey, setDefault }) {
  let text = existing || '';

  // Remove old / broken quay blocks (including dotted 4.5 mistake)
  text = stripQuayManaged(text);

  const defaultSlug = 'quay-grok-build';
  if (setDefault) {
    if (/^\[models\]/m.test(text)) {
      if (/^\[models\][\s\S]*?^default\s*=/m.test(text)) {
        text = text.replace(
          /(^\[models\][\s\S]*?)^default\s*=\s*"[^"]*"/m,
          `$1default = "${defaultSlug}"`,
        );
      } else {
        text = text.replace(/(^\[models\])/m, `$1\ndefault = "${defaultSlug}"`);
      }
      // high reasoning → chậm rõ (hello 10–20s); medium đủ dùng
      if (/^default_reasoning_effort\s*=/m.test(text)) {
        text = text.replace(
          /^default_reasoning_effort\s*=\s*"[^"]*"/m,
          'default_reasoning_effort = "medium"',
        );
      }
    } else {
      text =
        `[models]\ndefault = "${defaultSlug}"\ndefault_reasoning_effort = "medium"\n\n` +
        text;
    }
  }

  const lines = ['# --- Quay gateway (managed) ---'];
  for (const m of MODELS) {
    lines.push(
      `[model.${m.slug}]`,
      `model = "${m.model}"`,
      `base_url = "${baseUrl}"`,
      `name = "${m.name}"`,
      `description = "${m.description}"`,
      `api_key = "${apiKey}"`,
      `api_backend = "chat_completions"`,
      '',
    );
  }
  lines.push('# --- end Quay ---');

  text = text.trimEnd() + '\n\n' + lines.join('\n') + '\n';
  return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * Drop managed section + any leftover broken quay-grok-* tables
 * @param {string} text
 */
function stripQuayManaged(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let skipping = false;

  for (const line of lines) {
    const t = line.trim();
    if (t === '# --- Quay gateway (managed) ---') {
      skipping = true;
      continue;
    }
    if (t === '# --- end Quay ---') {
      skipping = false;
      continue;
    }
    // table header
    if (t.startsWith('[') && t.endsWith(']')) {
      const isQuayModel =
        /^\[model\.quay[-_]|model\."quay|model\.quay-grok/i.test(t) ||
        t.startsWith('[model.quay-grok') ||
        t === '[model.quay]';
      if (isQuayModel || skipping) {
        // starting a quay table — skip until next non-quay table or end of quay block
        skipping = true;
        // if this is a non-quay table while we thought we were in managed block
        if (!isQuayModel && !t.startsWith('[model.quay')) {
          skipping = false;
          out.push(line);
        }
        continue;
      }
      skipping = false;
    }
    if (skipping) continue;
    out.push(line);
  }
  return out.join('\n');
}

export function printGrokEnvExport() {
  const state = loadState();
  const baseUrl = `http://127.0.0.1:${state.port}/v1`;
  return [
    `# OpenAI-compatible clients → Quay`,
    `export OPENAI_BASE_URL="${baseUrl}"`,
    `export OPENAI_API_KEY="${state.localApiKey}"`,
    `# Grok CLI: /model quay-grok-build  OR  quay-grok-45  (not bare grok-4.5)`,
  ].join('\n');
}
