import type { ReactElement } from 'react';
import { TONE_VAR, scoreLabel, scoreTone } from '../lib/colors';

/** 0–100 score arc. Track is a lighter step; fill carries the status. */
export function Gauge({ value, size = 168, label = 'Overall score' }: { value: number | null; size?: number; label?: string }): ReactElement {
  const stroke = 12;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const sweep = 240;
  const startAngle = 150; // degrees, clockwise from +x
  const v = value === null || !Number.isFinite(value) ? null : Math.max(0, Math.min(100, value));
  const tone = scoreTone(v);

  const pt = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  };
  const arc = (from: number, to: number) => {
    const [x0, y0] = pt(from);
    const [x1, y1] = pt(to);
    const large = to - from > 180 ? 1 : 0;
    return `M${x0.toFixed(2)},${y0.toFixed(2)}A${r},${r} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
  };

  return (
    <div className="gauge" style={{ width: size }}>
      <svg width={size} height={size * 0.82} viewBox={`0 0 ${size} ${size * 0.82}`} role="img" aria-label={`${label}: ${v === null ? 'no data' : `${Math.round(v)} of 100, ${scoreLabel(v)}`}`}>
        <path d={arc(startAngle, startAngle + sweep)} className="gauge-track" strokeWidth={stroke} fill="none" strokeLinecap="round" />
        {v !== null && v > 0 ? (
          <path
            d={arc(startAngle, startAngle + (sweep * v) / 100)}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
            style={{ stroke: TONE_VAR[tone] }}
          />
        ) : null}
        <text x={cx} y={cy + 4} textAnchor="middle" className="gauge-value">
          {v === null ? '—' : Math.round(v)}
        </text>
        <text x={cx} y={cy + 26} textAnchor="middle" className="gauge-caption">
          {v === null ? 'no data' : `${scoreLabel(v)} · of 100`}
        </text>
      </svg>
    </div>
  );
}

/** Thin horizontal meter for category scores. */
export function ScoreMeter({ value }: { value: number | null }): ReactElement {
  const v = value === null || !Number.isFinite(value) ? null : Math.max(0, Math.min(100, value));
  const tone = scoreTone(v);
  return (
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v ?? undefined} aria-valuetext={v === null ? 'no data' : `${Math.round(v)} of 100`}>
      {v !== null ? <div className="meter-fill" style={{ width: `${v}%`, background: TONE_VAR[tone] }} /> : null}
    </div>
  );
}
