/**
 * In-memory ring buffer of recent gateway requests (for UI Logs tab).
 */

const MAX = 200;

/** @type {LogEntry[]} */
const entries = [];

/**
 * @typedef {{
 *  id: string,
 *  at: string,
 *  ts: number,
 *  provider: string,
 *  accountId?: string | null,
 *  email?: string | null,
 *  model?: string | null,
 *  path?: string,
 *  stream?: boolean,
 *  status?: number | null,
 *  ms?: number,
 *  ok?: boolean,
 *  error?: string | null,
 * }} LogEntry
 */

/**
 * @param {Omit<LogEntry, 'id' | 'at' | 'ts'>} partial
 */
export function pushRequestLog(partial) {
  const ts = Date.now();
  /** @type {LogEntry} */
  const entry = {
    id: `log_${ts.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    at: new Date(ts).toISOString(),
    ts,
    provider: partial.provider || '—',
    accountId: partial.accountId ?? null,
    email: partial.email ?? null,
    model: partial.model ?? null,
    path: partial.path || '',
    stream: Boolean(partial.stream),
    status: partial.status ?? null,
    ms: partial.ms ?? 0,
    ok: partial.ok !== false,
    error: partial.error ?? null,
  };
  entries.unshift(entry);
  if (entries.length > MAX) entries.length = MAX;
  return entry;
}

/**
 * @param {number} [limit]
 */
export function listRequestLogs(limit = 100) {
  const n = Math.min(Math.max(1, Number(limit) || 100), MAX);
  return entries.slice(0, n);
}

export function clearRequestLogs() {
  entries.length = 0;
}

/** Last successful use per account id */
export function lastUsedByAccount() {
  /** @type {Record<string, LogEntry>} */
  const map = {};
  for (const e of entries) {
    if (!e.accountId || !e.ok) continue;
    if (!map[e.accountId]) map[e.accountId] = e;
  }
  return map;
}
