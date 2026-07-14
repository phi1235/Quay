#!/usr/bin/env node
/**
 * Quay CLI — local multi-account AI gateway
 *
 * Flow:
 *   1) quay import <token.json>
 *   2) quay pool-add <id|all>
 *   3) quay start
 *   4) quay apply-codex   # optional: point Codex CLI/IDE at Quay
 */

import path from 'node:path';
import { importTokenInput } from './import-json.js';
import { importGrokLogin, defaultGrokAuthPath } from './import-grok.js';
import {
  loadState,
  saveState,
  addToPool,
  removeFromPool,
  listPoolAccounts,
  isExpired,
  regenerateLocalApiKey,
  DATA_DIR,
} from './store.js';
import { startGateway } from './gateway.js';
import { applyCodexConfig, printEnvExport } from './apply-codex.js';
import { applyGrokConfig, printGrokEnvExport } from './apply-grok.js';

const [cmd, ...args] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case 'import':
      return cmdImport(args);
    case 'import-grok':
      return cmdImportGrok(args);
    case 'list':
      return cmdList();
    case 'pool-add':
      return cmdPoolAdd(args[0]);
    case 'pool-remove':
      return cmdPoolRemove(args[0]);
    case 'pool':
      return cmdPool();
    case 'status':
      return cmdStatus();
    case 'start':
      return cmdStart(args);
    case 'apply-codex':
      return cmdApplyCodex(args);
    case 'apply-grok':
      return cmdApplyGrok(args);
    case 'env':
      console.log(printEnvExport());
      console.log('');
      console.log(printGrokEnvExport());
      return;
    case 'regen-key':
      console.log(regenerateLocalApiKey());
      return;
    case 'help':
    case undefined:
      return printHelp();
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
  }
}

function printHelp() {
  console.log(`
Quay (quay) — local multi-account AI gateway

Usage:
  quay <command>
  node src/cli.js <command>

Commands:
  import <file.json>       Import Codex/ChatGPT token JSON
  import-grok [auth.json]  Import from grok login (~/.grok/auth.json)
  list                     List imported accounts
  pool-add <id|all>        Add account(s) to API service pool
  pool-remove <id>         Remove account from pool
  pool                     Show pool
  status                   Show gateway key/port/pool
  start [--port N]         Start local API + UI
  apply-codex              Point Codex CLI/IDE at this gateway
  apply-grok               Point Grok CLI at this gateway (~/.grok/config.toml)
  env                      Print env exports (Codex + Grok)
  regen-key                Rotate local API key

Typical flow (Codex):
  1. quay import ~/Downloads/account.json
  2. quay pool-add all && quay start && quay apply-codex

Typical flow (Grok — nhiều account):
  1. grok login          # account A
  2. quay import-grok    # vault giữ A
  3. grok login          # account B (ghi đè auth.json)
  4. quay import-grok    # vault = A + B
  5. quay start
  # model: grok-4.5 | grok-build

  Cũng có thể: cp ~/.grok/auth.json ./a.json  (mỗi acc 1 file) rồi
  quay import-grok ./a.json && quay import-grok ./b.json

Data dir: ${DATA_DIR}
`);
}

function cmdImportGrok(argv) {
  const file = argv[0] ? path.resolve(argv[0]) : undefined;
  const accounts = importGrokLogin(file);
  for (const a of accounts) addToPool(a.id);
  console.log(
    `Grok vault → ${accounts.length} account(s) (source: ${file || defaultGrokAuthPath()}):`,
  );
  for (const a of accounts) {
    console.log(
      `  - ${a.id}  ${a.email}  provider=grok  exp=${a.expiresAt || '-'}  pool=yes`,
    );
  }
  console.log('\nThêm acc khác: grok login (acc mới) → quay import-grok');
  console.log('Models: grok-4.5 | grok-build');
}

function cmdImport(argv) {
  const file = argv[0];
  if (!file) {
    console.error('Usage: import <file.json>');
    process.exit(1);
  }
  const abs = path.resolve(file);
  const accounts = importTokenInput(abs, { isPath: true });
  console.log(`Imported ${accounts.length} account(s):`);
  for (const a of accounts) {
    console.log(
      `  - ${a.id}  ${a.email}  provider=${a.provider || 'codex'}  plan=${a.planType || '-'}  exp=${a.expiresAt || '-'}  source=${a.source || '-'}`,
    );
  }
  console.log('\nNext: node src/cli.js pool-add all');
}

function cmdList() {
  const state = loadState();
  if (state.accounts.length === 0) {
    console.log('No accounts. Run: import <file.json> or import-grok');
    return;
  }
  for (const a of state.accounts) {
    const inPool = state.poolAccountIds.includes(a.id) ? 'POOL' : '----';
    const exp = isExpired(a) ? 'EXPIRED' : 'ok';
    console.log(
      `[${inPool}] ${a.id}  ${a.email}  ${a.provider || 'codex'}  plan=${a.planType || '-'}  ${exp}  enabled=${a.enabled}`,
    );
  }
}

function cmdPoolAdd(id) {
  if (!id) {
    console.error('Usage: pool-add <id|all>');
    process.exit(1);
  }
  const state = loadState();
  if (id === 'all') {
    for (const a of state.accounts) addToPool(a.id);
    console.log(`Added ${state.accounts.length} account(s) to pool`);
  } else {
    addToPool(id);
    console.log(`Added ${id} to pool`);
  }
  cmdPool();
}

function cmdPoolRemove(id) {
  if (!id) {
    console.error('Usage: pool-remove <id>');
    process.exit(1);
  }
  removeFromPool(id);
  console.log(`Removed ${id} from pool`);
}

function cmdPool() {
  const pool = listPoolAccounts();
  console.log(`Pool size: ${pool.length}`);
  for (const a of pool) {
    console.log(`  - ${a.id}  ${a.email}  exp=${a.expiresAt || '-'}`);
  }
}

function cmdStatus() {
  const state = loadState();
  console.log(
    JSON.stringify(
      {
        host: state.host,
        port: state.port,
        localApiKey: state.localApiKey,
        routing: state.routing,
        accounts: state.accounts.length,
        pool: state.poolAccountIds.length,
        baseUrl: `http://${state.host}:${state.port}/v1`,
        dataDir: DATA_DIR,
      },
      null,
      2,
    ),
  );
}

async function cmdStart(argv) {
  const portFlag = argv.indexOf('--port');
  let portOverride;
  if (portFlag >= 0) portOverride = Number(argv[portFlag + 1]);

  const state = loadState();
  if (portOverride) {
    state.port = portOverride;
    saveState(state);
  }
  if (listPoolAccounts().length === 0) {
    console.warn(
      '[warn] Pool is empty. Import + pool-add first. Gateway will return 503 until pool has accounts.',
    );
  }

  const started = await startGateway({ port: state.port, host: state.host });
  const { host, port, ui } = started;
  console.log('\n✅ Gateway + UI đang chạy. Giữ process này.');
  console.log(`   Mở UI:  ${ui || `http://${host}:${port}/`}`);
  console.log('   Trong UI: Thêm JSON → Pool → Gắn vào Codex');
  console.log('Or set env:\n' + printEnvExport());

  // best-effort open browser for end users
  if (!process.env.QUAY_NO_OPEN && !process.env.CLG_NO_OPEN) {
    try {
      const { exec } = await import('node:child_process');
      const url = ui || `http://${host}:${port}/`;
      const cmd =
        process.platform === 'darwin'
          ? `open "${url}"`
          : process.platform === 'win32'
            ? `start "" "${url}"`
            : `xdg-open "${url}"`;
      exec(cmd);
    } catch {
      /* ignore */
    }
  }
}

function cmdApplyCodex(argv) {
  const result = applyCodexConfig({
    backup: !argv.includes('--no-backup'),
  });
  console.log('Applied Codex local config:');
  console.log(JSON.stringify(result, null, 2));
  console.log('\nStart gateway if not running: node src/cli.js start');
  console.log('Then run: codex');
}

function cmdApplyGrok(argv) {
  const result = applyGrokConfig({
    backup: !argv.includes('--no-backup'),
    setDefault: !argv.includes('--no-default'),
  });
  console.log('Applied Grok CLI config (Quay models):');
  console.log(JSON.stringify(result, null, 2));
  console.log('\nStart gateway if not running: node src/cli.js start');
  console.log('Then run: grok');
  console.log('Models in picker: Quay · Grok Build / Quay · Grok 4.5');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
