/**
 * ChatGPT / Codex quota via:
 *   GET https://chatgpt.com/backend-api/wham/usage
 * (same endpoint family as Cockpit)
 */

const USAGE_URL =
  process.env.QUAY_USAGE_URL ||
  process.env.CLG_USAGE_URL ||
  'https://chatgpt.com/backend-api/wham/usage';

/**
 * @param {import('./store.js').Account} account
 */
export async function fetchAccountQuota(account) {
  if (!account?.accessToken) {
    throw new Error('Account thiếu accessToken');
  }

  const headers = {
    Authorization: `Bearer ${account.accessToken}`,
    Accept: 'application/json',
    'User-Agent':
      process.env.QUAY_USER_AGENT ||
      process.env.CLG_USER_AGENT ||
      'Mozilla/5.0 (X11; Linux x86_64) quay/0.1.0',
    Referer: 'https://chatgpt.com/',
  };
  if (account.accountId) {
    headers['ChatGPT-Account-Id'] = account.accountId;
  }

  const res = await fetch(USAGE_URL, { method: 'GET', headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Quota API ${res.status}: ${text.slice(0, 240)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Quota API trả JSON không hợp lệ');
  }

  return parseUsageResponse(data);
}

/**
 * @param {any} data
 */
export function parseUsageResponse(data) {
  const rate = data?.rate_limit || {};
  // primary / secondary — độ dài cửa sổ phụ thuộc plan:
  //   k12/plus: primary ≈ 5h, secondary ≈ 7 ngày
  //   free:     primary ≈ 30 ngày, secondary thường null
  const primary = rate.primary_window || null;
  const secondary = rate.secondary_window || null;
  const credits = data?.credits || null;
  const resetCredits = data?.rate_limit_reset_credits || null;

  const hourly = mapWindow(primary, 'primary');
  const weekly = mapWindow(secondary, 'secondary');

  return {
    planType: data?.plan_type || null,
    email: data?.email || null,
    accountId: data?.account_id || null,
    userId: data?.user_id || null,
    allowed: rate.allowed ?? null,
    limitReached: rate.limit_reached ?? null,
    /** % còn lại (remaining). Tên field hourly/weekly giữ tương thích; nhãn UI lấy windowLabel */
    hourly,
    weekly,
    credits: credits
      ? {
          hasCredits: Boolean(credits.has_credits),
          unlimited: Boolean(credits.unlimited),
          overageLimitReached: Boolean(credits.overage_limit_reached),
          balance: credits.balance ?? null,
        }
      : null,
    resetCreditsAvailable: resetCredits?.available_count ?? 0,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * @param {any} window
 * @param {string} label
 */
function mapWindow(window, label) {
  if (!window || typeof window !== 'object') {
    return {
      present: false,
      label,
      usedPercent: null,
      remainingPercent: null,
      windowSeconds: null,
      windowMinutes: null,
      windowLabel: null,
      resetAfterSeconds: null,
      resetAt: null,
      resetAtIso: null,
      resetInLabel: null,
    };
  }

  const used = clampPercent(window.used_percent);
  const remaining = used == null ? null : 100 - used;
  const windowSeconds =
    typeof window.limit_window_seconds === 'number' ? window.limit_window_seconds : null;
  const resetAfter =
    typeof window.reset_after_seconds === 'number' ? window.reset_after_seconds : null;
  let resetAt =
    typeof window.reset_at === 'number'
      ? window.reset_at
      : resetAfter != null
        ? Math.floor(Date.now() / 1000) + resetAfter
        : null;

  return {
    present: true,
    label,
    usedPercent: used,
    remainingPercent: remaining,
    windowSeconds,
    windowMinutes: windowSeconds != null ? Math.ceil(windowSeconds / 60) : null,
    windowLabel: formatWindowLabel(windowSeconds, label),
    resetAfterSeconds: resetAfter,
    resetAt,
    resetAtIso: resetAt != null ? new Date(resetAt * 1000).toISOString() : null,
    resetInLabel: formatDuration(resetAfter),
  };
}

function clampPercent(v) {
  if (v == null || Number.isNaN(Number(v))) return null;
  const n = Math.round(Number(v));
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/**
 * Nhãn cửa sổ theo limit_window_seconds thật từ API (không hardcode 5h).
 * @param {number | null} seconds
 * @param {string} fallback
 */
function formatWindowLabel(seconds, fallback) {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return fallback;
  // < 90 phút → phút
  if (seconds < 90 * 60) return `${Math.max(1, Math.round(seconds / 60))} phút`;
  // < 36 giờ → giờ (vd 5h = 18000s)
  if (seconds < 36 * 3600) {
    const h = Math.round(seconds / 3600);
    return `${h} giờ`;
  }
  // < 45 ngày → ngày (vd 7 ngày, 30 ngày)
  if (seconds < 45 * 86400) {
    const d = Math.round(seconds / 86400);
    return `${d} ngày`;
  }
  // dài hơn → tháng xấp xỉ
  const mo = Math.round(seconds / (30 * 86400));
  return `${Math.max(1, mo)} tháng`;
}

function formatDuration(seconds) {
  if (seconds == null || seconds < 0) return null;
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} ngày ${h} giờ`;
  if (h > 0) return `${h} giờ ${m} phút`;
  return `${m} phút`;
}
