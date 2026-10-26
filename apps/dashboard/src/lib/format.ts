/** Number/duration/byte formatting. Every helper tolerates null/NaN → "—". */

export const DASH = '—';

const nf0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const compactNf = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

export function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function fmtNum(v: number | null | undefined, digits: 0 | 1 | 2 = 0): string {
  if (!isNum(v)) return DASH;
  return (digits === 0 ? nf0 : digits === 1 ? nf1 : nf2).format(v);
}

export function fmtCompact(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  return Math.abs(v) < 10_000 ? nf0.format(v) : compactNf.format(v);
}

/** Milliseconds → "0.42 ms" / "184 ms" / "1.24 s" / "2m 05s". */
export function fmtMs(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (a === 0) return '0 ms';
  if (a < 1) return `${sign}${a.toFixed(2)} ms`;
  if (a < 10) return `${sign}${a.toFixed(1)} ms`;
  if (a < 1000) return `${sign}${Math.round(a)} ms`;
  if (a < 10_000) return `${sign}${(a / 1000).toFixed(2)} s`;
  if (a < 60_000) return `${sign}${(a / 1000).toFixed(1)} s`;
  const totalSec = Math.round(a / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${sign}${h}h ${String(m).padStart(2, '0')}m`;
  return `${sign}${m}m ${String(s).padStart(2, '0')}s`;
}

/** Elapsed clock "mm:ss" / "h:mm:ss". */
export function fmtClock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Offset from a window start, e.g. "+12.48 s". */
export function fmtOffset(ms: number | null | undefined): string {
  if (!isNum(ms)) return DASH;
  const sign = ms < 0 ? '−' : '+';
  const a = Math.abs(ms);
  if (a < 1000) return `${sign}${a.toFixed(a < 10 ? 1 : 0)} ms`;
  if (a < 60_000) return `${sign}${(a / 1000).toFixed(2)} s`;
  const m = Math.floor(a / 60_000);
  const s = (a % 60_000) / 1000;
  return `${sign}${m}m ${s.toFixed(1).padStart(4, '0')}s`;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function fmtBytes(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  let n = Math.abs(v);
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  const s = i === 0 ? String(Math.round(n)) : n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : Math.round(n).toString();
  return `${v < 0 ? '−' : ''}${s} ${UNITS[i]}`;
}

export function fmtKb(v: number | null | undefined): string {
  return isNum(v) ? fmtBytes(v * 1024) : DASH;
}

export function fmtSignedKb(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  return `${v > 0 ? '+' : ''}${fmtKb(v)}`;
}

/** 0..100 → "42.1%". */
export function fmtPct(v: number | null | undefined, digits: 0 | 1 = 1): string {
  if (!isNum(v)) return DASH;
  return `${digits === 0 ? Math.round(v) : v.toFixed(1)}%`;
}

export function fmtFps(v: number | null | undefined): string {
  return isNum(v) ? `${v.toFixed(v >= 100 ? 0 : 1)} fps` : DASH;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function fmtRelative(ts: number | null | undefined, now = Date.now()): string {
  if (!isNum(ts)) return DASH;
  const diff = ts - now;
  const a = Math.abs(diff);
  if (a < 45_000) return diff <= 0 ? 'just now' : 'in a few seconds';
  if (a < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (a < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  if (a < 30 * 86_400_000) return rtf.format(Math.round(diff / 86_400_000), 'day');
  return fmtDate(ts);
}

const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function fmtDate(ts: number | null | undefined): string {
  return isNum(ts) ? dateFmt.format(ts) : DASH;
}
export function fmtDateTime(ts: number | null | undefined): string {
  return isNum(ts) ? dateTimeFmt.format(ts) : DASH;
}
export function fmtTime(ts: number | null | undefined): string {
  if (!isNum(ts)) return DASH;
  return `${timeFmt.format(ts)}.${String(Math.floor(ts % 1000)).padStart(3, '0')}`;
}

export function fmtMetric(value: number, unit: string): string {
  switch (unit) {
    case 'ms':
      return fmtMs(value);
    case 'kb':
    case 'KB':
      return fmtKb(value);
    case 'bytes':
    case 'B':
      return fmtBytes(value);
    case '%':
      return fmtPct(value);
    case 'fps':
      return fmtFps(value);
    default:
      return `${fmtNum(value, Math.abs(value) < 10 ? 2 : 0)}${unit ? ` ${unit}` : ''}`;
  }
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${fmtNum(n)} ${n === 1 ? one : many}`;
}

export function shortId(id: string): string {
  return id.length > 10 ? id.slice(0, 8) : id;
}

/** Only allow http(s) URLs to become links. */
export function safeHttpUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Short path of a URL for dense tables. */
export function urlPath(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.pathname}${u.search}`;
  } catch {
    return raw;
  }
}
