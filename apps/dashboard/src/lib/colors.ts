import type { EventType } from '@rnpa/shared';

/** Categorical slots, fixed order (never cycled; extras fold into "other"). */
export const SERIES = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
  'var(--series-7)',
  'var(--series-8)',
] as const;
export const SERIES_OTHER = 'var(--series-other)';

export function seriesColor(slot: number): string {
  return SERIES[slot] ?? SERIES_OTHER;
}

/* --------------------------- event type groups -------------------------- */

export type EventGroup =
  | 'lifecycle'
  | 'navigation'
  | 'network'
  | 'js'
  | 'rendering'
  | 'resources'
  | 'interaction'
  | 'failures'
  | 'marks';

export const EVENT_GROUPS: { id: EventGroup; label: string; types: EventType[]; color: string }[] = [
  { id: 'navigation', label: 'Navigation', types: ['SCREEN_ENTER', 'SCREEN_RENDER', 'SCREEN_READY'], color: 'var(--series-1)' },
  { id: 'interaction', label: 'User actions', types: ['USER_ACTION'], color: 'var(--series-2)' },
  { id: 'network', label: 'Network', types: ['API_START', 'API_END'], color: 'var(--series-3)' },
  { id: 'js', label: 'JS', types: ['FUNCTION', 'TIMER', 'LONG_TASK'], color: 'var(--series-4)' },
  { id: 'rendering', label: 'Rendering', types: ['RENDER', 'FPS', 'FRAME_DROP'], color: 'var(--series-5)' },
  { id: 'resources', label: 'Memory/CPU', types: ['MEMORY', 'CPU'], color: 'var(--series-6)' },
  {
    id: 'lifecycle',
    label: 'Lifecycle',
    types: ['APP_START', 'JS_INIT', 'FIRST_RENDER', 'APP_READY', 'APP_STATE', 'STARTUP'],
    color: 'var(--series-7)',
  },
  { id: 'failures', label: 'Errors', types: ['ERROR', 'CRASH'], color: 'var(--critical)' },
  { id: 'marks', label: 'Marks', types: ['MARK'], color: 'var(--text-muted)' },
];

const groupByType = new Map<string, (typeof EVENT_GROUPS)[number]>();
for (const g of EVENT_GROUPS) for (const t of g.types) groupByType.set(t, g);

export function eventGroup(type: string): (typeof EVENT_GROUPS)[number] | undefined {
  return groupByType.get(type);
}

export function eventColor(type: string): string {
  return groupByType.get(type)?.color ?? 'var(--text-muted)';
}

/* -------------------------------- status -------------------------------- */

export type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'info' | 'accent' | 'neutral';

export function scoreTone(score: number | null | undefined): Tone {
  if (score === null || score === undefined || !Number.isFinite(score)) return 'neutral';
  if (score >= 80) return 'good';
  if (score >= 60) return 'warning';
  if (score >= 40) return 'serious';
  return 'critical';
}

export function scoreLabel(score: number | null | undefined): string {
  switch (scoreTone(score)) {
    case 'good':
      return 'Good';
    case 'warning':
      return 'Needs work';
    case 'serious':
      return 'Poor';
    case 'critical':
      return 'Critical';
    default:
      return 'No data';
  }
}

export function httpTone(status: number | null, error: string | null): Tone {
  if (error || status === null) return error ? 'critical' : 'neutral';
  if (status >= 500) return 'critical';
  if (status >= 400) return 'serious';
  if (status >= 300) return 'info';
  return 'good';
}

export const TONE_VAR: Record<Tone, string> = {
  good: 'var(--good)',
  warning: 'var(--warning)',
  serious: 'var(--serious)',
  critical: 'var(--critical)',
  info: 'var(--info)',
  accent: 'var(--accent)',
  neutral: 'var(--series-other)',
};

/* ------------------------ canvas: resolve CSS vars ----------------------- */

/** Resolve `var(--x)` strings to concrete colors for canvas drawing. */
export function resolveCssColor(value: string, el: Element = document.documentElement): string {
  const m = /^var\((--[a-z0-9-]+)\)$/i.exec(value.trim());
  if (!m || !m[1]) return value;
  const v = getComputedStyle(el).getPropertyValue(m[1]).trim();
  return v || '#888';
}
