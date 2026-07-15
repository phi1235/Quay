const $ = (id) => document.getElementById(id);

const VIEW_META = {
  dashboard: {
    title: 'Tổng quan',
    desc: 'Trạng thái gateway và pool account',
  },
  accounts: {
    title: 'Tài khoản',
    desc: 'Import JSON, pool API, quota theo plan',
  },
  service: {
    title: 'Dịch vụ API',
    desc: 'Endpoint local, key và routing',
  },
  connect: {
    title: 'CLI / IDE',
    desc: 'Gắn từng provider vào gateway local',
  },
  logs: {
    title: 'Logs',
    desc: 'Request qua Quay — account & model thực tế',
  },
};

const ICO = {
  poolOn:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
  poolOff:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12h14"/></svg>',
  refresh:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/></svg>',
  power:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v8"/><path d="M7.5 6.2a7 7 0 1 0 9 0"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M7 7l1 13h8l1-13"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 17v5"/><path d="M9 3h6l1 7h2l-5 5-5-5h2L9 3z"/></svg>',
  pinOn:
    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.2"><path d="M12 17v5"/><path d="M9 3h6l1 7h2l-5 5-5-5h2L9 3z"/></svg>',
};

const VIEW_KEY = 'quay_view';
const VIEW_KEY_LEGACY = 'clg_view';
const VALID_VIEWS = new Set(Object.keys(VIEW_META));
/** Thời gian tối thiểu hiện loading (ms) để user kịp thấy nút đã chạy */
const LOADING_MIN_MS = 400;

let currentView = 'dashboard';
/** @type {any | null} */
let lastStatus = null;
const FILTER_KEY = 'quay_account_filters';
const FILTER_KEY_LEGACY = 'clg_account_filters';

/** @type {{ q: string, pool: string, plan: string, status: string }} */
const accountFilters = loadAccountFilters();

function loadAccountFilters() {
  const defaults = { q: '', pool: 'all', plan: 'all', status: 'all' };
  try {
    const raw =
      sessionStorage.getItem(FILTER_KEY) || sessionStorage.getItem(FILTER_KEY_LEGACY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return {
      q: typeof parsed.q === 'string' ? parsed.q : '',
      pool: ['all', 'yes', 'no'].includes(parsed.pool) ? parsed.pool : 'all',
      plan: typeof parsed.plan === 'string' ? parsed.plan : 'all',
      status: ['all', 'on', 'off', 'expired'].includes(parsed.status) ? parsed.status : 'all',
    };
  } catch {
    return defaults;
  }
}

function saveAccountFilters() {
  try {
    sessionStorage.setItem(FILTER_KEY, JSON.stringify(accountFilters));
  } catch {
    /* ignore */
  }
}

function filtersActive() {
  return (
    accountFilters.q.trim() !== '' ||
    accountFilters.pool !== 'all' ||
    accountFilters.plan !== 'all' ||
    accountFilters.status !== 'all'
  );
}

function readSavedView() {
  const hash = (location.hash || '').replace(/^#/, '').trim();
  if (VALID_VIEWS.has(hash)) return hash;
  try {
    const fromLocal = localStorage.getItem(VIEW_KEY) || localStorage.getItem(VIEW_KEY_LEGACY);
    if (VALID_VIEWS.has(fromLocal)) return fromLocal;
  } catch {
    /* ignore */
  }
  try {
    const stored = sessionStorage.getItem(VIEW_KEY) || sessionStorage.getItem(VIEW_KEY_LEGACY);
    if (VALID_VIEWS.has(stored)) return stored;
  } catch {
    /* ignore */
  }
  const boot = document.documentElement.getAttribute('data-view');
  if (VALID_VIEWS.has(boot)) return boot;
  return 'dashboard';
}

function persistView(view) {
  try {
    sessionStorage.setItem(VIEW_KEY, view);
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    /* ignore */
  }
  document.documentElement.setAttribute('data-view', view);
  const next = `${location.pathname}${location.search}#${view}`;
  const cur = `${location.pathname}${location.search}${location.hash || ''}`;
  if (cur !== next) {
    history.replaceState(null, '', next);
  }
}

async function fetchStatus() {
  const res = await fetch('/api/status');
  if (!res.ok) throw new Error('Không lấy được trạng thái');
  return res.json();
}

/**
 * Chạy async với hiệu ứng loading trên nút đến khi xong (tối thiểu LOADING_MIN_MS).
 * @param {HTMLElement | null} el
 * @param {() => Promise<any>} fn
 */
async function withLoading(el, fn) {
  if (!el) return fn();
  if (el.dataset.loading === '1') return;
  el.dataset.loading = '1';
  el.classList.add('is-loading');
  el.setAttribute('aria-busy', 'true');
  const prevDisabled = el.disabled;
  el.disabled = true;
  const started = Date.now();
  try {
    return await fn();
  } finally {
    const wait = LOADING_MIN_MS - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    el.dataset.loading = '0';
    el.classList.remove('is-loading');
    el.removeAttribute('aria-busy');
    el.disabled = prevDisabled;
  }
}

function toast(msg, isErr = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2800);
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('vi-VN');
  } catch {
    return iso;
  }
}

/** Giờ reset cụ thể, dễ đọc: "15:04 · 15/07" */
function fmtResetAt(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const mon = String(d.getMonth() + 1).padStart(2, '0');
    return `${hh}:${mm} · ${day}/${mon}`;
  } catch {
    return '—';
  }
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Custom tooltip for [data-tip] */
function bindTooltips() {
  const tip = $('tip');
  let active = null;

  const hide = () => {
    tip.classList.add('hidden');
    active = null;
  };

  const show = (el) => {
    const text = el.getAttribute('data-tip');
    if (!text) return;
    active = el;
    tip.textContent = text;
    tip.classList.remove('hidden');
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = r.left + r.width / 2;
    let top = r.top - 10;
    left = Math.max(12 + tw / 2, Math.min(left, window.innerWidth - 12 - tw / 2));
    if (top - th < 8) {
      top = r.bottom + th + 10;
      tip.style.transform = 'translate(-50%, 0)';
    } else {
      tip.style.transform = 'translate(-50%, -100%)';
    }
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  document.addEventListener(
    'mouseover',
    (e) => {
      const el = e.target.closest('[data-tip]');
      if (!el || el.disabled) return;
      show(el);
    },
    true,
  );
  document.addEventListener(
    'mouseout',
    (e) => {
      const el = e.target.closest('[data-tip]');
      if (!el) return;
      if (active === el) hide();
    },
    true,
  );
  document.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
}

/**
 * @param {string} message
 * @param {{ title?: string, okText?: string, cancelText?: string, danger?: boolean }} [opts]
 */
function showConfirm(message, opts = {}) {
  const modal = $('confirmModal');
  const okBtn = $('confirmOk');
  const cancelBtn = $('confirmCancel');
  $('confirmTitle').textContent = opts.title || 'Xác nhận';
  $('confirmMessage').textContent = message;
  okBtn.textContent = opts.okText || 'Đồng ý';
  cancelBtn.textContent = opts.cancelText || 'Hủy';
  if (opts.danger) {
    okBtn.classList.add('danger', 'danger-ok');
    okBtn.classList.remove('primary');
  } else {
    okBtn.classList.add('primary');
    okBtn.classList.remove('danger', 'danger-ok');
  }
  modal.classList.remove('hidden');

  return new Promise((resolve) => {
    const finish = (value) => {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onBackdrop = (e) => {
      if (e.target === modal) finish(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') finish(false);
      if (e.key === 'Enter') finish(true);
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    okBtn.focus();
  });
}

function showView(name, { persist = true } = {}) {
  const view = VALID_VIEWS.has(name) ? name : 'dashboard';
  currentView = view;
  document.querySelectorAll('.view').forEach((el) => {
    el.classList.toggle('active', el.id === `view-${view}`);
  });
  document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  const meta = VIEW_META[view] || VIEW_META.dashboard;
  $('pageTitle').textContent = meta.title;
  const descEl = $('pageDesc');
  descEl.textContent = meta.desc || '';
  descEl.hidden = !meta.desc;

  if (persist) {
    persistView(view);
  } else {
    document.documentElement.setAttribute('data-view', view);
  }

  if (view === 'logs') startLogsPolling();
  else stopLogsPolling();
}

function render(s) {
  lastStatus = s;
  $('statAccounts').textContent = String(s.accountsTotal);
  $('statPool').textContent = String(s.poolSize);
  $('statPort').textContent = String(s.port);
  $('sidePort').textContent = `:${s.port}`;
  $('baseUrl').value = s.baseUrl;
  $('apiKey').value = s.localApiKey;
  $('routing').value = s.routing;
  $('dataDir').textContent = s.dataDir;
  $('envBox').textContent =
    `export OPENAI_BASE_URL="${s.baseUrl}"\nexport OPENAI_API_KEY="${s.localApiKey}"`;
  const hint = $('connectPoolHint');
  if (hint) {
    const c = s.poolCodex ?? '—';
    const g = s.poolGrok ?? '—';
    const p = s.poolPerplexity ?? '—';
    hint.textContent = `codex ${c} · grok ${g} · pplx ${p}`;
  }
  renderDashPool(s);
  syncFilterControls(s);
  renderAccounts(s);
}

function renderDashPool(s) {
  const box = $('dashPool');
  const pool = (s.accounts || []).filter((a) => a.inPool);
  if (!pool.length) {
    box.className = 'dash-pool empty-box';
    box.textContent = 'Chưa có account trong pool.';
    return;
  }
  box.className = 'dash-pool';
  box.innerHTML = pool
    .slice(0, 8)
    .map((a) => {
      const h = a.quota?.hourly?.remainingPercent;
      const w = a.quota?.weekly?.remainingPercent;
      const hl = windowTitle(a.quota?.hourly, 'C1');
      const wl = windowTitle(a.quota?.weekly, 'C2');
      const q =
        h != null || w != null
          ? `${hl} ${h ?? '—'}%${w != null ? ` · ${wl} ${w}%` : ''}`
          : '—';
      return `
        <div class="dash-item">
          <div class="account-main">
            <div class="email">${escapeHtml(a.email)}</div>
            <div class="sub">${escapeHtml(q)}</div>
          </div>
          ${a.planType != null && a.planType !== '' ? `<span class="chip plan">${escapeHtml(String(a.planType))}</span>` : ''}
        </div>`;
    })
    .join('');
}

/**
 * @param {any[]} accounts
 */
function filterAccounts(accounts) {
  const q = accountFilters.q.trim().toLowerCase();
  return accounts.filter((a) => {
    if (accountFilters.pool === 'yes' && !a.inPool) return false;
    if (accountFilters.pool === 'no' && a.inPool) return false;

    if (accountFilters.plan !== 'all') {
      const plan = String(a.planType || a.provider || '').toLowerCase() || '__none__';
      if (plan !== accountFilters.plan && (a.provider || 'codex') !== accountFilters.plan) {
        return false;
      }
    }

    if (accountFilters.status === 'on' && !a.enabled) return false;
    if (accountFilters.status === 'off' && a.enabled) return false;
    if (accountFilters.status === 'expired' && !a.expired) return false;

    if (q) {
      const hay = [a.email, a.planType, a.id, a.accountId, a.userId, a.source]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/**
 * Cập nhật option Plan + đồng bộ control (không phá focus khi đang gõ search).
 * @param {any} s
 */
function syncFilterControls(s) {
  const planSel = $('filterPlan');
  if (!planSel) return;

  const plans = [
    ...new Set(
      (s.accounts || [])
        .flatMap((a) => [
          (a.provider || 'codex').toLowerCase(),
          String(a.planType ?? '').trim().toLowerCase(),
        ])
        .filter(Boolean),
    ),
  ].sort();

  const prev = accountFilters.plan;
  const opts = ['<option value="all">Plan</option>']
    .concat(plans.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`));
  if ((s.accounts || []).some((a) => !a.planType && !a.provider)) {
    opts.push('<option value="__none__">(trống)</option>');
  }
  planSel.innerHTML = opts.join('');
  if (prev !== 'all' && ![...planSel.options].some((o) => o.value === prev)) {
    accountFilters.plan = 'all';
  }
  planSel.value = accountFilters.plan;

  const search = $('accountSearch');
  const pool = $('filterPool');
  const status = $('filterStatus');
  if (search && document.activeElement !== search) search.value = accountFilters.q;
  if (pool) pool.value = accountFilters.pool;
  if (status) status.value = accountFilters.status;

  const clearBtn = $('btnClearFilters');
  if (clearBtn) clearBtn.hidden = !filtersActive();
}

function renderAccounts(s) {
  const list = $('accountList');
  const countEl = $('filterCount');
  const all = s.accounts || [];

  if (!all.length) {
    list.innerHTML = '<div class="empty-box">Chưa có tài khoản. Bấm <b>Thêm JSON</b>.</div>';
    if (countEl) countEl.textContent = '';
    const clearBtn = $('btnClearFilters');
    if (clearBtn) clearBtn.hidden = true;
    return;
  }

  const filtered = filterAccounts(all);
  if (countEl) {
    countEl.textContent =
      filtered.length === all.length
        ? `${all.length} account`
        : `${filtered.length} / ${all.length}`;
  }
  const clearBtn = $('btnClearFilters');
  if (clearBtn) clearBtn.hidden = !filtersActive();

  if (!filtered.length) {
    list.innerHTML =
      '<div class="empty-box">Không có account khớp bộ lọc. <b>Xóa lọc</b> để xem lại.</div>';
    return;
  }

  list.innerHTML = filtered
    .map((a) => {
      const prov = providerLabel(a.provider);
      const chips = [
        `<span class="chip ${chipClass(prov)}">${escapeHtml(prov)}</span>`,
        a.inPool ? '<span class="chip ok">pool</span>' : '',
        a.pinned ? '<span class="chip pin">pin</span>' : '',
        a.planType != null && String(a.planType) !== prov
          ? `<span class="chip plan">${escapeHtml(String(a.planType))}</span>`
          : '',
        a.expired ? '<span class="chip warn">hết hạn</span>' : '',
        !a.enabled ? '<span class="chip warn">tắt</span>' : '',
        a.coolingDown ? '<span class="chip warn">cooldown</span>' : '',
        /deactivated_workspace/i.test(String(a.quotaError || a.lastError || ''))
          ? '<span class="chip danger">deactivated</span>'
          : '',
      ]
        .filter(Boolean)
        .join('');

      return `
      <article class="account ${a.pinned ? 'is-pinned' : ''} ${a.quotaError || a.lastError ? 'has-error' : ''}" data-id="${escapeHtml(a.id)}" data-enabled="${a.enabled ? '1' : '0'}">
        <div class="account-row">
          <div class="account-main">
            <div class="email" title="${escapeHtml(a.email)}">${escapeHtml(a.email)}</div>
          </div>
          <div class="account-right">
            <div class="chips">${chips}</div>
            <div class="account-actions">
              <button type="button" class="icon-btn ${a.pinned ? 'is-pinned' : ''}" data-act="pin" data-tip="${a.pinned ? 'Bỏ pin' : 'Pin — ưu tiên (first)'}">${a.pinned ? ICO.pinOn : ICO.pin}</button>
              ${
                a.inPool
                  ? `<button type="button" class="icon-btn" data-act="pool-off" data-tip="Gỡ khỏi pool">${ICO.poolOff}</button>`
                  : `<button type="button" class="icon-btn" data-act="pool-on" data-tip="Thêm vào pool">${ICO.poolOn}</button>`
              }
              <button type="button" class="icon-btn" data-act="quota" data-tip="Làm mới quota">${ICO.refresh}</button>
              <button type="button" class="icon-btn" data-act="toggle" data-tip="${a.enabled ? 'Tắt' : 'Bật'}">${ICO.power}</button>
              <button type="button" class="icon-btn danger" data-act="del" data-tip="Xóa">${ICO.trash}</button>
            </div>
          </div>
        </div>
        ${renderQuota(a)}
      </article>`;
    })
    .join('');
}

function applyAccountFiltersFromUi() {
  const search = $('accountSearch');
  const pool = $('filterPool');
  const plan = $('filterPlan');
  const status = $('filterStatus');
  accountFilters.q = search?.value || '';
  accountFilters.pool = pool?.value || 'all';
  accountFilters.plan = plan?.value || 'all';
  accountFilters.status = status?.value || 'all';
  saveAccountFilters();
  if (lastStatus) renderAccounts(lastStatus);
}

function clearAccountFilters() {
  accountFilters.q = '';
  accountFilters.pool = 'all';
  accountFilters.plan = 'all';
  accountFilters.status = 'all';
  saveAccountFilters();
  const search = $('accountSearch');
  const pool = $('filterPool');
  const plan = $('filterPlan');
  const status = $('filterStatus');
  if (search) search.value = '';
  if (pool) pool.value = 'all';
  if (plan) plan.value = 'all';
  if (status) status.value = 'all';
  if (lastStatus) {
    syncFilterControls(lastStatus);
    renderAccounts(lastStatus);
  }
}

function providerLabel(p) {
  if (p === 'grok') return 'grok';
  if (p === 'perplexity' || p === 'pplx') return 'perplexity';
  return 'codex';
}

function chipClass(prov) {
  if (prov === 'grok') return 'grok';
  if (prov === 'perplexity') return 'pplx';
  return 'plan';
}

function renderQuota(a) {
  if (a.provider === 'grok') {
    return renderGrokHint(a);
  }
  if (a.provider === 'perplexity' || a.provider === 'pplx') {
    return renderPerplexityHint(a);
  }
  const errBanner = renderAccountError(a);
  const q = a.quota;
  if (!q) {
    return `${errBanner}<div class="quota-empty">${
      a.quotaError
        ? escapeHtml(shortError(a.quotaError))
        : 'Chưa có quota — bấm ↻ để lấy'
    }</div>`;
  }
  // Nhãn theo limit_window_seconds thật (free = 30 ngày, k12 = 5 giờ + 7 ngày)
  return `
    ${errBanner}
    <div class="quota-grid">
      ${quotaCard(windowTitle(q.hourly, 'Cửa sổ 1'), 'Primary window', q.hourly)}
      ${quotaCard(windowTitle(q.weekly, 'Cửa sổ 2'), 'Secondary window', q.weekly)}
    </div>`;
}

/** Banner lỗi token / workspace (402 deactivated, 401, …) */
function renderAccountError(a) {
  const raw = a.quotaError || a.lastError;
  if (!raw) return '';
  const short = shortError(raw);
  const isDead = /deactivated|402|Unauthorized|401|403/i.test(String(raw));
  return `<div class="account-error ${isDead ? 'is-dead' : ''}" title="${escapeHtml(String(raw))}">${escapeHtml(short)}</div>`;
}

function shortError(raw) {
  const s = String(raw || '');
  if (/deactivated_workspace/i.test(s)) return 'Workspace đã bị deactivate (402)';
  if (/Unauthorized|401/i.test(s)) return 'Token không hợp lệ / không có quyền Codex (401)';
  if (/403/i.test(s)) return 'Bị từ chối (403)';
  if (/429|rate/i.test(s)) return 'Rate limit (429)';
  // Quota API 402: {...}
  const m = s.match(/Quota API\s+(\d+):\s*(.+)/i);
  if (m) {
    try {
      const j = JSON.parse(m[2]);
      const code = j?.detail?.code || j?.detail || m[2];
      return `Quota ${m[1]}: ${typeof code === 'string' ? code : JSON.stringify(code)}`;
    } catch {
      return s.length > 120 ? `${s.slice(0, 120)}…` : s;
    }
  }
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}

function renderGrokHint(a) {
  const exp = a.expiresAt ? fmtResetAt(a.expiresAt) : '—';
  return `<div class="quota-empty">Grok login · hết hạn token ~ ${escapeHtml(exp)} · usage xem grok.com</div>`;
}

function renderPerplexityHint(a) {
  const exp = a.expiresAt ? fmtResetAt(a.expiresAt) : '—';
  const tier = a.planType ? String(a.planType) : 'session';
  return `<div class="quota-empty">Perplexity cookies · ${escapeHtml(tier)} · session ~ ${escapeHtml(exp)} · model pplx-pro / pplx-turbo / …</div>`;
}

/**
 * Tiêu đề card theo limit_window_seconds thật.
 * free: 30 ngày · k12 primary: 5 giờ · secondary: 7 ngày
 */
function windowTitle(w, fallback) {
  if (!w || !w.present) return fallback;
  const fromSec = formatWindowSeconds(w.windowSeconds);
  if (fromSec) return fromSec;
  // bỏ nhãn cũ sai ("5h" khi window = 30 ngày)
  if (w.windowLabel && w.windowLabel !== '5h' && w.windowLabel !== 'primary' && w.windowLabel !== 'secondary') {
    return w.windowLabel;
  }
  return fallback;
}

function formatWindowSeconds(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds)) || seconds <= 0) return null;
  const s = Number(seconds);
  if (s < 90 * 60) return `${Math.max(1, Math.round(s / 60))} phút`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} giờ`;
  if (s < 45 * 86400) return `${Math.round(s / 86400)} ngày`;
  return `${Math.max(1, Math.round(s / (30 * 86400)))} tháng`;
}

function quotaCard(title, hint, w) {
  if (!w || !w.present) {
    return `
      <div class="quota-card is-empty">
        <div class="qc-head">
          <span class="qc-title">${escapeHtml(title)}</span>
          <span class="qc-pct">—</span>
        </div>
        <div class="quota-bar"><i style="width:0%"></i></div>
        <div class="qc-foot">Không áp dụng</div>
      </div>`;
  }
  const rem = w.remainingPercent;
  const used = w.usedPercent;
  const cls = rem == null ? '' : rem <= 15 ? 'low' : rem <= 40 ? 'mid' : '';
  const pctCls = rem == null ? '' : rem <= 15 ? 'is-low' : rem <= 40 ? 'is-mid' : '';
  const width = rem == null ? 0 : rem;
  const at = fmtResetAt(w.resetAtIso);
  const inLabel = w.resetInLabel || '';
  const tip = [hint, w.windowLabel, inLabel ? `còn ${inLabel}` : '']
    .filter(Boolean)
    .join(' · ');
  return `
    <div class="quota-card" data-tip="${escapeHtml(tip)}">
      <div class="qc-head">
        <span class="qc-title">${escapeHtml(title)}</span>
        <span class="qc-pct ${pctCls}">${rem ?? '—'}%</span>
      </div>
      <div class="quota-bar"><i class="${cls}" style="width:${width}%"></i></div>
      <div class="qc-foot">
        <span>Dùng ${used ?? '—'}%</span>
        <span class="qc-reset">Reset <strong>${escapeHtml(at)}</strong></span>
      </div>
    </div>`;
}

async function reload(btn) {
  const run = async () => {
    try {
      render(await fetchStatus());
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  };
  if (btn) return withLoading(btn, run);
  return run();
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function bindUi() {
  bindTooltips();

  document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });
  document.querySelectorAll('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.goto));
  });

  const search = $('accountSearch');
  if (search) {
    search.value = accountFilters.q;
    let t = 0;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => applyAccountFiltersFromUi(), 120);
    });
  }
  ['filterPool', 'filterPlan', 'filterStatus'].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('change', () => applyAccountFiltersFromUi());
  });
  const clearBtn = $('btnClearFilters');
  if (clearBtn) clearBtn.onclick = () => clearAccountFilters();

  $('btnRefresh').onclick = () => reload($('btnRefresh'));

  $('btnToggleKey').onclick = () => {
    const input = $('apiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
  };

  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-copy');
      await navigator.clipboard.writeText($(id).value);
      toast('Đã copy');
    });
  });

  $('btnCopyEnv').onclick = async () => {
    await navigator.clipboard.writeText($('envBox').textContent);
    toast('Đã copy ENV');
  };

  $('btnRegenKey').onclick = async () => {
    const ok = await showConfirm(
      'Tạo API key mới? CLI/IDE đang dùng key cũ sẽ phải copy lại.',
      { title: 'Tạo key mới', okText: 'Tạo key', danger: true },
    );
    if (!ok) return;
    try {
      await api('/api/settings/regen-key', { method: 'POST', body: '{}' });
      await reload();
      toast('Đã tạo key mới');
    } catch (e) {
      toast(e.message, true);
    }
  };

  $('routing').onchange = async () => {
    try {
      await api('/api/settings/routing', {
        method: 'POST',
        body: JSON.stringify({ routing: $('routing').value }),
      });
      toast('Đã đổi routing');
    } catch (e) {
      toast(e.message, true);
    }
  };

  const bindApply = (btnId, opts) => {
    const btn = $(btnId);
    if (!btn) return;
    btn.onclick = async () => {
      const ok = await showConfirm(opts.message, {
        title: opts.title,
        okText: 'Áp dụng',
      });
      if (!ok) return;
      await withLoading(btn, async () => {
        try {
          await api(opts.path, {
            method: 'POST',
            body: JSON.stringify(opts.body || { backup: true }),
          });
          toast(opts.okToast);
        } catch (e) {
          toast(e.message, true);
        }
      });
    };
  };

  bindApply('btnApplyCodex', {
    title: 'Gắn Codex',
    message: 'Ghi cấu hình vào ~/.codex để CLI/IDE dùng Quay?',
    path: '/api/apply-codex',
    body: { backup: true },
    okToast: 'Đã gắn Codex',
  });

  bindApply('btnApplyGrok', {
    title: 'Gắn Grok CLI',
    message:
      'Ghi model Quay vào ~/.grok/config.toml?\n• Grok: quay-grok-build, quay-grok-45\n• PPLX Pro: quay-pplx-pro, sonar, terra, gemini, claude, glm, kimi, grok, nemotron',
    path: '/api/apply-grok',
    body: { backup: true, setDefault: true },
    okToast:
      'Đã gắn Grok CLI — /model quay-grok-* hoặc quay-pplx-* (Perplexity), rồi restart grok',
  });

  $('btnPoolAll').onclick = async () => {
    try {
      await api('/api/pool/add-all', { method: 'POST', body: '{}' });
      await reload();
      toast('Đã thêm tất cả vào pool');
    } catch (e) {
      toast(e.message, true);
    }
  };

  $('btnRefreshQuota').onclick = async () => {
    await withLoading($('btnRefreshQuota'), async () => {
      try {
        const data = await api('/api/quota/refresh', {
          method: 'POST',
          body: JSON.stringify({ onlyPool: false }),
        });
        if (data.status) render(data.status);
        else await reload();
        const ok = (data.results || []).filter((r) => r.ok).length;
        const fail = (data.results || []).filter((r) => !r.ok).length;
        toast(`Quota: ${ok} OK${fail ? `, ${fail} lỗi` : ''}`);
      } catch (e) {
        toast(e.message, true);
      }
    });
  };

  const modal = $('modal');
  $('btnOpenImport').onclick = () => modal.classList.remove('hidden');
  $('btnCloseImport').onclick = () => modal.classList.add('hidden');
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });

  $('btnImportGrok').onclick = async () => {
    await withLoading($('btnImportGrok'), async () => {
      try {
        // Popup device login — không đụng ~/.grok/auth.json / web session
        const start = await api('/api/import-grok/login/start', {
          method: 'POST',
          body: JSON.stringify({ autoPool: true }),
        });
        const url = start.verificationUriComplete;
        // popup mới — force login/chọn acc (prompt=login select_account phía server)
        const popup = window.open(
          url,
          `quay-grok-login-${Date.now()}`,
          'width=520,height=740,menubar=no,toolbar=no',
        );
        if (!popup) {
          toast('Cho phép popup rồi bấm lại, hoặc mở link trong tab mới.', true);
          window.open(url, '_blank');
        } else {
          toast('Popup: nếu Signed in acc cũ → Sign out → login acc mới → Authorize');
        }

        const deadline = Date.now() + 15 * 60 * 1000;
        let done = false;
        while (Date.now() < deadline && !done) {
          await new Promise((r) => setTimeout(r, 2500));
          const st = await fetch(
            `/api/import-grok/login/${encodeURIComponent(start.id)}?autoPool=1`,
          ).then((r) => r.json());
          if (st.status === 'ok') {
            done = true;
            try {
              popup?.close();
            } catch {
              /* ignore */
            }
            if (st.statusFull) render(st.statusFull);
            else await reload();
            showView('accounts');
            toast(
              `Đã thêm Grok${st.email ? `: ${st.email}` : ''} · vault ${st.vault?.count ?? '—'} (CLI/web không đổi)`,
            );
            break;
          }
          if (st.status === 'error' || st.status === 'expired') {
            done = true;
            toast(st.error || 'Login Grok thất bại', true);
            break;
          }
        }
        if (!done) toast('Hết thời gian chờ login Grok', true);
      } catch (e) {
        toast(e.message, true);
      }
    });
  };

  $('fileInput').onchange = async () => {
    const f = $('fileInput').files?.[0];
    if (!f) return;
    $('importText').value = await f.text();
  };

  $('btnDoImport').onclick = async () => {
    const text = $('importText').value;
    const autoPool = $('autoPool').checked;
    $('importResult').textContent = 'Đang import…';
    try {
      const data = await api('/api/import', {
        method: 'POST',
        body: JSON.stringify({ text, autoPool }),
      });
      $('importResult').textContent = `OK — ${data.count} account`;
      $('importText').value = '';
      $('fileInput').value = '';
      await reload();
      showView('accounts');
      toast(`Import ${data.count} account`);
      setTimeout(() => modal.classList.add('hidden'), 350);
    } catch (e) {
      $('importResult').textContent = e.message;
      toast(e.message, true);
    }
  };

  $('accountList').onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const card = btn.closest('.account');
    const id = card?.dataset.id;
    if (!id) return;
    const act = btn.dataset.act;
    try {
      if (act === 'pin') {
        const isPinned = card.classList.contains('is-pinned');
        await api(`/api/accounts/${id}/pin`, {
          method: 'POST',
          body: JSON.stringify({ pin: !isPinned }),
        });
        toast(isPinned ? 'Đã bỏ pin' : 'Đã pin — ưu tiên khi first/sticky');
      } else if (act === 'pool-on') {
        await api(`/api/accounts/${id}/pool`, {
          method: 'POST',
          body: JSON.stringify({ join: true }),
        });
        toast('Đã vào pool');
      } else if (act === 'pool-off') {
        await api(`/api/accounts/${id}/pool`, {
          method: 'POST',
          body: JSON.stringify({ join: false }),
        });
        toast('Đã gỡ pool');
      } else if (act === 'quota') {
        await withLoading(btn, async () => {
          await api(`/api/accounts/${id}/quota`, { method: 'POST', body: '{}' });
          toast('Đã cập nhật quota');
        });
      } else if (act === 'toggle') {
        const currentlyOn = card.dataset.enabled === '1';
        await api(`/api/accounts/${id}/enabled`, {
          method: 'POST',
          body: JSON.stringify({ enabled: !currentlyOn }),
        });
      } else if (act === 'del') {
        const ok = await showConfirm('Xóa account này? Không hoàn tác được.', {
          title: 'Xóa tài khoản',
          okText: 'Xóa',
          danger: true,
        });
        if (!ok) return;
        await api(`/api/accounts/${id}`, { method: 'DELETE' });
        toast('Đã xóa');
      }
      await reload();
    } catch (err) {
      toast(err.message, true);
    }
  };
}

let logsTimer = 0;

async function loadLogs() {
  const body = $('logBody');
  if (!body) return;
  try {
    const data = await fetch('/api/logs?limit=100').then((r) => r.json());
    const logs = data.logs || [];
    if (!logs.length) {
      body.innerHTML =
        '<tr><td colspan="7" class="log-empty">Chưa có request. Chat qua model Quay để thấy log.</td></tr>';
      return;
    }
    body.innerHTML = logs
      .map((e) => {
        const t = e.at
          ? new Date(e.at).toLocaleTimeString('vi-VN', { hour12: false })
          : '—';
        const stCls = e.ok ? 'ok' : 'err';
        const st =
          e.status != null
            ? `${e.status}${e.ok ? '' : ' ✗'}`
            : e.error
              ? 'ERR'
              : '—';
        const errTip = e.error ? ` title="${escapeHtml(e.error)}"` : '';
        return `<tr${errTip}>
          <td class="mono">${escapeHtml(t)}</td>
          <td><span class="chip ${chipClass(providerLabel(e.provider))}">${escapeHtml(e.provider || '—')}</span></td>
          <td title="${escapeHtml(e.accountId || '')}">${escapeHtml(e.email || '—')}</td>
          <td class="mono">${escapeHtml(e.model || '—')}</td>
          <td class="mono">${escapeHtml(e.path || '')}${e.stream ? ' · stream' : ''}</td>
          <td class="mono">${e.ms != null ? e.ms : '—'}</td>
          <td class="${stCls}">${escapeHtml(String(st))}</td>
        </tr>`;
      })
      .join('');
  } catch (err) {
    body.innerHTML = `<tr><td colspan="7" class="log-empty">${escapeHtml(err.message || String(err))}</td></tr>`;
  }
}

function startLogsPolling() {
  stopLogsPolling();
  loadLogs();
  logsTimer = setInterval(loadLogs, 2500);
}

function stopLogsPolling() {
  if (logsTimer) {
    clearInterval(logsTimer);
    logsTimer = 0;
  }
}

bindUi();

const btnRefreshLogs = $('btnRefreshLogs');
if (btnRefreshLogs) btnRefreshLogs.onclick = () => loadLogs();
const btnClearLogs = $('btnClearLogs');
if (btnClearLogs) {
  btnClearLogs.onclick = async () => {
    try {
      await api('/api/logs', { method: 'DELETE' });
      await loadLogs();
      toast('Đã xóa log');
    } catch (e) {
      toast(e.message, true);
    }
  };
}

showView(readSavedView(), { persist: true });
window.addEventListener('hashchange', () => {
  const hash = (location.hash || '').replace(/^#/, '').trim();
  if (VALID_VIEWS.has(hash) && hash !== currentView) {
    showView(hash, { persist: true });
  }
});
reload();
setInterval(() => reload(), 10000);
