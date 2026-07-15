# Quay

**Quay** — local multi-account AI gateway.

Import token accounts → pool → one local OpenAI-compatible API for CLI / IDE.

Codex is the first client; more providers/clients can land later without renaming the product.

**Author:** [Phipari](https://github.com/phi1235)

---

## Flow

```
token.json (access_token)
        │
        ▼
   quay import          → store accounts
        │
        ▼
   quay pool-add all    → API service pool
        │
        ▼
   quay start           → http://127.0.0.1:43690/v1  (+ UI)
        │
        ▼
   quay apply-codex     → optional: point ~/.codex at Quay
        │
        ▼
   codex / IDE / any OpenAI client
```

---

## Install (npm)

```bash
npm i -g @phi1235/quay
quay start
```

One-shot without global install:

```bash
npx @phi1235/quay start
```

Data (accounts, keys, vault) is stored in **`~/.quay`** when installed from npm.  
Override: `export QUAY_DATA_DIR=/path/to/dir`.

On `quay start`, Quay checks npm for a newer version and prints an update hint if available  
(`QUAY_NO_UPDATE=1` to disable).

### From source (git)

```bash
git clone https://github.com/phi1235/Quay.git
cd Quay && npm install && npm start
# data stays in ./data when running from clone
```

Open: `http://127.0.0.1:43690/`

1. **+ Thêm JSON** — Codex / ChatGPT token  
2. **+ Grok** — popup login hoặc `~/.grok/auth.json`  
3. Account vào **pool**  
4. **CLI / IDE** → Áp dụng Codex / Grok  

### CLI

```bash
# Codex
quay import file.json
quay pool-add all
quay start
quay apply-codex

# Grok
quay import-grok   # or UI + Grok
quay start
quay apply-grok
eval "$(quay env)"
# models: quay-grok-build | quay-grok-45

# Perplexity (no native CLI — use Grok CLI as client)
quay import cookies.json   # EditThisCookie export from perplexity.ai
quay pool-add all && quay start
quay apply-grok            # registers quay-pplx-* into ~/.grok/config.toml
# in grok: /model quay-pplx-pro
```

### Routing theo model

| Model | Provider pool |
|-------|----------------|
| `grok-4.5`, `grok-build` | Grok (OIDC từ `grok login`) → `api.x.ai` |
| `pplx-*`, `sonar` | Perplexity (browser cookies) → web session SSE |
| còn lại (gpt-*, o*) | Codex / ChatGPT session |

**Grok CLI slugs** (sau `quay apply-grok`), Perplexity Pro unlocked:

| Slug | Web model | `model_preference` |
|------|-----------|--------------------|
| `quay-pplx-pro` | Best | `pplx_pro` |
| `quay-pplx-turbo` | Best (turbo) | `turbo` |
| `quay-pplx-sonar` | Sonar 2 | `experimental` |
| `quay-pplx-terra` | GPT-5.6 Terra | `gpt56_terra` |
| `quay-pplx-gemini` | Gemini 3.1 Pro | `gemini31pro_high` |
| `quay-pplx-claude` | Claude Sonnet 5 | `claude50sonnet` |
| `quay-pplx-glm` | GLM 5.2 | `glm_5_2` |
| `quay-pplx-kimi` | Kimi K2.6 | `kimik26instant` |
| `quay-pplx-grok` | Grok 4.5 | `grok45low` |
| `quay-pplx-nemotron` | Nemotron 3 Ultra | `nv_nemotron_3_ultra` |

Max-locked web models (GPT-5.6 Sol, Claude Opus 4.8) are not registered.

Override: header `X-Quay-Provider: grok|codex|perplexity`

---

## Import formats

| Format | Example |
|--------|---------|
| Sub2API export | `{ "accounts": [{ "platform":"openai", "credentials":{ "access_token":… } }] }` |
| Flat credentials | `{ "access_token", "email", "chatgpt_account_id", "plan_type" }` |
| Codex auth.json | `{ "tokens": { "access_token", … } }` |
| Raw lines | one JWT / token per line |

Access-token-only is fine. Re-import when JWT expires.

---

## CLI commands

| Command | Meaning |
|---------|---------|
| `import <file>` | Add accounts |
| `list` | All accounts |
| `pool-add <id\|all>` | Add to pool |
| `pool-remove <id>` | Remove from pool |
| `pool` | Show pool |
| `status` | Port, key, counts |
| `start [--port N]` | Run gateway + UI |
| `apply-codex` | Point Codex CLI/IDE at Quay |
| `env` | Shell exports |
| `regen-key` | Rotate local API key |

Data: `./data/state.json` (or `QUAY_DATA_DIR`).

---

## HTTP API

Base: `http://127.0.0.1:<port>/v1`  
Auth: `Authorization: Bearer <localApiKey>` (`quay_…`)

| Path | Notes |
|------|--------|
| `GET /health` | No auth |
| `GET /v1/models` | Model list |
| `POST /v1/responses` | Primary (Codex wire) |
| `POST /v1/chat/completions` | Converted → responses upstream |

---

## Env vars

| Var | Meaning |
|-----|---------|
| `QUAY_DATA_DIR` | State directory |
| `QUAY_NO_OPEN` | Don’t open browser on start |
| `QUAY_UPSTREAM_BASE` | Override Codex upstream |
| `QUAY_USAGE_URL` | Override quota URL |

Legacy `CLG_*` names still work as fallbacks.

---

## Layout

```
quay/
├── src/
│   ├── cli.js
│   ├── store.js
│   ├── import-json.js
│   ├── gateway.js
│   ├── upstream.js
│   ├── quota.js
│   ├── api.js
│   └── apply-codex.js
├── public/              # Web UI
├── data/                # runtime state (gitignored)
├── package.json
└── README.md
```
