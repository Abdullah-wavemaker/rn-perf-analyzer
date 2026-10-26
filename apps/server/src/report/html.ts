import type { AnalysisReport, SeriesPoint, Stat } from '@rnpa/shared';
import type { AppRecord, SessionRecord } from '../db.js';

/**
 * Self-contained, script-free HTML report. Every value that originates from
 * the app or device (screen names, URLs, component names, messages) goes
 * through `esc()`. Served with a CSP that forbids scripts entirely.
 */

export const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ms = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
const kb = (v: number | null | undefined) => (v === null || v === undefined ? '—' : Math.abs(v) >= 1024 ? `${(v / 1024).toFixed(1)} MB` : `${Math.round(v)} KB`);
const statCell = (s: Stat | null) => (s ? `${ms(s.p50)} <span class="muted">p90 ${ms(s.p90)}</span>` : '—');

function scoreClass(score: number | null): string {
  if (score === null) return 'na';
  return score >= 90 ? 'good' : score >= 50 ? 'ok' : 'bad';
}

function sparkline(points: SeriesPoint[], width = 520, height = 80): string {
  if (points.length < 2) return '<p class="muted">Not enough samples.</p>';
  const xs = points.map((p) => p.ts);
  const ys = points.map((p) => p.value);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y1 = Math.max(...ys, 1);
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(((p.ts - x0) / Math.max(1, x1 - x0)) * width).toFixed(1)},${(height - (p.value / y1) * (height - 4)).toFixed(1)}`)
    .join(' ');
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="trend"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '<p class="muted">No data.</p>';
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

export function renderReport(session: SessionRecord, app: AppRecord, r: AnalysisReport): string {
  const categories = Object.entries(r.score.categories)
    .map(([name, c]) => `<div class="cat ${scoreClass(c.score)}"><div class="v">${c.score ?? '—'}</div><div class="k">${esc(name)}</div><div class="n">${esc(c.note)}</div></div>`)
    .join('');

  const bottlenecks = r.bottlenecks.length
    ? r.bottlenecks
        .map(
          (b) => `<li class="b ${esc(b.severity)}"><div class="bh"><span class="sev">${esc(b.severity)}</span><span class="cat-tag">${esc(b.category)}</span><strong>${esc(b.title)}</strong></div><p>${esc(b.detail)}</p><p class="rec">${esc(b.recommendation)}</p></li>`,
        )
        .join('')
    : '<li class="muted">No bottlenecks detected.</li>';

  const startupRows = r.startup.runs.map((run) => [esc(run.kind), esc(run.iteration ?? ''), ms(run.ttid), ms(run.jsInit), ms(run.firstRender), ms(run.tti)]);
  const screenRows = r.navigation.screens.map((s) => [esc(s.screen), String(s.visits), statCell(s.tti), statCell(s.firstRender), statCell(s.transition), String(s.apiCalls), String(s.droppedFrames), String(s.score ?? '—')]);
  const endpointRows = r.network.endpoints.slice(0, 50).map((e) => [`<code>${esc(e.endpoint)}</code>`, String(e.count), String(e.errors), statCell(e.duration), ms(e.duration?.max ?? null)]);
  const longTaskRows = [...r.js.longTasks].sort((a, b) => b.duration - a.duration).slice(0, 20).map((t) => [ms(t.duration), esc(t.screen ?? ''), esc(t.suspects.map((s) => `${s.name} (${ms(s.duration)})`).join(', '))]);
  const fnRows = r.js.functions.slice(0, 20).map((f) => [`<code>${esc(f.name)}</code>`, esc(f.origin), String(f.count), ms(f.total), ms(f.max)]);
  const componentRows = r.rendering.components.slice(0, 20).map((c) => [`<code>${esc(c.name)}</code>`, String(c.renders), String(c.peakPerSecond), c.excessive ? 'yes' : '']);
  const memorySeries = r.memory.series.filter((p) => p.pssKb !== null).map((p) => ({ ts: p.ts, value: p.pssKb as number }));
  const cpuSeries = r.cpu.series.map((p) => ({ ts: p.ts, value: p.total }));

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Performance report — ${esc(app.packageName)}</title>
<style>
:root{--bg:#fff;--fg:#1a1d21;--muted:#646b75;--line:#e3e6ea;--good:#1f8a4c;--ok:#b7791f;--bad:#c53030;--card:#f7f8fa}
@media (prefers-color-scheme: dark){:root{--bg:#121417;--fg:#e6e8eb;--muted:#9aa3ad;--line:#2a2f36;--card:#1a1e23}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:32px 20px}h1{font-size:22px;margin:0}h2{font-size:16px;margin:32px 0 12px;border-bottom:1px solid var(--line);padding-bottom:6px}
.muted{color:var(--muted)}.meta{color:var(--muted);margin-top:4px}
.score{display:flex;gap:24px;align-items:center;margin:24px 0}.big{font-size:56px;font-weight:700;line-height:1}
.cats{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}.cat{background:var(--card);border-radius:8px;padding:10px;border-top:3px solid var(--line)}
.cat .v{font-size:22px;font-weight:600}.cat .k{text-transform:capitalize}.cat .n{color:var(--muted);font-size:12px}
.good{border-color:var(--good)}.ok{border-color:var(--ok)}.bad{border-color:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}
code{font-size:12px;word-break:break-all}ul{list-style:none;padding:0;margin:0}.b{background:var(--card);border-radius:8px;padding:12px 14px;margin-bottom:10px;border-left:4px solid var(--line)}
.b.critical,.b.high{border-left-color:var(--bad)}.b.medium{border-left-color:var(--ok)}.b.low,.b.info{border-left-color:var(--muted)}
.bh{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.sev,.cat-tag{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:0 6px}
.b p{margin:6px 0 0}.rec{color:var(--muted)}svg{color:var(--fg)}
</style></head><body><main>
<h1>Performance report</h1>
<div class="meta">${esc(app.packageName)} ${esc(app.versionName ?? '')} · ${esc(session.variant)} build · ${esc(session.deviceModel ?? session.serial)} · session “${esc(session.name)}” · generated ${esc(new Date(r.generatedAt).toISOString())}</div>
<div class="score"><div class="big ${scoreClass(r.score.overall)}">${r.score.overall ?? '—'}</div><div class="muted">Overall score (0–100). Categories without data are excluded.</div></div>
<div class="cats">${categories}</div>
<h2>Top bottlenecks</h2><ul>${bottlenecks}</ul>
<h2>Startup</h2>${table(['Kind', 'Run', 'TTID', 'JS init', 'First render', 'TTI'], startupRows)}
<h2>Screens</h2>${table(['Screen', 'Visits', 'TTI', 'First render', 'Transition', 'API calls', 'Dropped frames', 'Score'], screenRows)}
<h2>Network</h2>${table(['Endpoint', 'Calls', 'Errors', 'Duration', 'Max'], endpointRows)}
<h2>Long JS tasks</h2>${table(['Duration', 'Screen', 'Suspects'], longTaskRows)}
<h2>Expensive functions</h2>${table(['Function', 'Origin', 'Calls', 'Total', 'Max'], fnRows)}
<h2>Re-renders</h2>${table(['Component', 'Renders', 'Peak / s', 'Excessive'], componentRows)}
<h2>Memory</h2><p>Start ${kb(r.memory.startKb)} · end ${kb(r.memory.endKb)} · peak ${kb(r.memory.peakKb)} · growth ${kb(r.memory.growthKb)}</p>${sparkline(memorySeries)}
<h2>CPU</h2><p>Average ${r.cpu.avg ?? '—'}% · peak ${r.cpu.peak ?? '—'}% · UI thread ${r.cpu.uiAvg ?? '—'}% · JS thread ${r.cpu.jsAvg ?? '—'}%</p>${sparkline(cpuSeries)}
<h2>Stability</h2><p>${r.stability.crashes.length} crashes · ${r.stability.errors.length} JS errors</p>
</main></body></html>`;
}
