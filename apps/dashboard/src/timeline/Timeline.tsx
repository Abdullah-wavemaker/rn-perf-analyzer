import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react';
import type { PerfEvent } from '@rnpa/shared';
import { useElementSize } from '../api/hooks';
import { Button } from '../components/Button';
import { JsonTree } from '../components/JsonTree';
import { FloatingTooltip, TipRow, TipTitle, type TooltipState } from '../charts/Tooltip';
import { eventColor, resolveCssColor } from '../lib/colors';
import { fmtDateTime, fmtMs, fmtOffset, fmtTime } from '../lib/format';
import { useColorSchemeVersion, useDevicePixelRatio } from '../lib/theme';
import { drawTimeline } from './draw';
import { hitKey, hitTest, type HitResult } from './hit';
import { GUTTER_W, buildTimelineModel, laneTops, totalHeight, type TimelineModel } from './model';
import { centerOn, clampView, fitView, panBy, xToTime, zoomAt, type View } from './view';

export interface TimelineProps {
  events: readonly PerfEvent[];
  /** Center the view on this epoch-ms timestamp. */
  focusTs: number | null;
  /** Event ids to outline (e.g. bottleneck evidence). */
  highlightIds: readonly string[];
  onClearFocus?: () => void;
}

const FOCUS_SPAN_MS = 6000;

function tooltipFor(h: HitResult, model: TimelineModel): TooltipState['content'] {
  if (h.kind === 'span') {
    const s = h.span;
    return (
      <>
        <TipTitle>{s.label}</TipTitle>
        <TipRow color={resolveCssColor(s.color)} label={s.ev.type} value={fmtMs(s.end - s.start)} />
        <TipRow label="start" value={fmtOffset(s.start - model.start)} />
        {s.ev.screen ? <div className="tip-detail">Screen: {s.ev.screen}</div> : null}
      </>
    );
  }
  if (h.kind === 'tick') {
    const t = h.tick;
    return (
      <>
        <TipTitle>{t.label}</TipTitle>
        <TipRow color={resolveCssColor(t.color)} label={t.ev.type} value={fmtOffset(t.ts - model.start)} />
        {t.ev.duration !== null ? <TipRow label="duration" value={fmtMs(t.ev.duration)} /> : null}
        {t.ev.screen ? <div className="tip-detail">Screen: {t.ev.screen}</div> : null}
      </>
    );
  }
  return (
    <>
      <TipTitle>
        {h.lane.label} · {fmtOffset(h.ts - model.start)}
      </TipTitle>
      {h.series.map((r) => (
        <TipRow key={r.def.id} color={resolveCssColor(r.def.color)} label={r.def.label} value={r.def.format(r.pt.value)} />
      ))}
    </>
  );
}

function eventOfHit(h: HitResult | null): PerfEvent | null {
  if (!h) return null;
  if (h.kind === 'span') return h.span.ev;
  if (h.kind === 'tick') return h.tick.ev;
  return h.series[0]?.pt.ev ?? null;
}

export function Timeline({ events, focusTs, highlightIds, onClearFocus }: TimelineProps): ReactElement {
  const model = useMemo(() => buildTimelineModel(events), [events]);
  const tops = useMemo(() => laneTops(model), [model]);
  const height = useMemo(() => totalHeight(model), [model]);
  const bounds = useMemo(() => ({ start: model.start, end: model.end }), [model]);
  const highlight = useMemo(() => new Set(highlightIds), [highlightIds]);

  const [wrapRef, { width }] = useElementSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dpr = useDevicePixelRatio();
  const themeVersion = useColorSchemeVersion();

  const [view, setView] = useState<View>(() => (focusTs !== null ? centerOn(focusTs, FOCUS_SPAN_MS, bounds) : fitView(bounds)));
  const [hover, setHover] = useState<HitResult | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [tip, setTip] = useState<TooltipState | null>(null);
  const [selected, setSelected] = useState<PerfEvent | null>(null);

  const viewRef = useRef(view);
  viewRef.current = view;
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const widthRef = useRef(width);
  widthRef.current = width;

  /* ---- initial framing: when data first arrives or focus changes ---- */
  const hadData = useRef(model.count > 0);
  useEffect(() => {
    if (model.count > 0 && !hadData.current) {
      hadData.current = true;
      setView(focusTs !== null ? centerOn(focusTs, FOCUS_SPAN_MS, bounds) : fitView(bounds));
    }
  }, [model.count, bounds, focusTs]);

  useEffect(() => {
    if (focusTs !== null) setView(centerOn(focusTs, Math.min(FOCUS_SPAN_MS, Math.max(1000, (boundsRef.current.end - boundsRef.current.start) * 1.02)), boundsRef.current));
  }, [focusTs]);

  // Select the first highlighted event that exists so its details are visible.
  useEffect(() => {
    for (const id of highlightIds) {
      const ev = model.byId.get(id);
      if (ev) {
        setSelected(ev);
        return;
      }
    }
  }, [highlightIds, model]);

  /* ---- color resolution cache (reset on theme change) ---- */
  const colorFn = useMemo(() => {
    const cache = new Map<string, string>();
    const root = document.documentElement;
    return (c: string) => {
      let v = cache.get(c);
      if (v === undefined) {
        v = resolveCssColor(c, root);
        cache.set(c, v);
      }
      return v;
    };
    // themeVersion is the cache key: a scheme flip must re-resolve every color.
  }, [themeVersion]);

  const font = useMemo(() => getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() || 'system-ui, sans-serif', []);

  /* ---- draw ---- */
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    const w = Math.floor(width);
    const pxW = Math.floor(w * dpr);
    const pxH = Math.floor(height * dpr);
    if (canvas.width !== pxW) canvas.width = pxW;
    if (canvas.height !== pxH) canvas.height = pxH;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawTimeline(ctx, {
      model,
      tops,
      view,
      width: w,
      height,
      color: colorFn,
      font,
      hover,
      hoverX,
      selectedId: selected?.id ?? null,
      highlight,
      focusTs,
    });
  }, [model, tops, view, width, height, dpr, colorFn, font, hover, hoverX, selected, highlight, focusTs]);

  /* ---- wheel / pinch (needs a non-passive listener) ---- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x < GUTTER_W) return; // let the page scroll over the gutter
      e.preventDefault();
      const plotW = Math.max(1, widthRef.current - GUTTER_W);
      const v = viewRef.current;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
        const d = e.shiftKey && dx === 0 ? dy : dx;
        setView(panBy(v, (d / plotW) * (v.end - v.start), boundsRef.current));
        return;
      }
      const intensity = e.ctrlKey ? 0.01 : 0.0018; // ctrlKey = trackpad pinch
      const factor = Math.exp(dy * intensity);
      const anchor = xToTime(x, v, GUTTER_W, plotW);
      setView(zoomAt(v, anchor, factor, boundsRef.current));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  /* ---- drag to pan, click to select ---- */
  const drag = useRef<{ x: number; view: View; moved: boolean; id: number } | null>(null);

  const localPoint = (e: PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const { x } = localPoint(e);
    drag.current = { x, view: viewRef.current, moved: false, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const updateHover = useCallback(
    (x: number, y: number, clientX: number, clientY: number) => {
      const h = hitTest(model, tops, viewRef.current, widthRef.current, x, y);
      setHover((prev) => (hitKey(prev) === hitKey(h) ? prev : h));
      setHoverX(x >= GUTTER_W ? x : null);
      setTip(h ? { x: clientX, y: clientY, content: tooltipFor(h, model) } : null);
    },
    [model, tops],
  );

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = localPoint(e);
    const d = drag.current;
    if (d && d.id === e.pointerId) {
      const dx = x - d.x;
      if (Math.abs(dx) > 3) d.moved = true;
      if (d.moved) {
        const plotW = Math.max(1, widthRef.current - GUTTER_W);
        setView(panBy(d.view, (-dx / plotW) * (d.view.end - d.view.start), boundsRef.current));
        setTip(null);
        setHoverX(x >= GUTTER_W ? x : null);
        return;
      }
    }
    updateHover(x, y, e.clientX, e.clientY);
  };

  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d || d.moved) return;
    const { x, y } = localPoint(e);
    const h = hitTest(model, tops, viewRef.current, widthRef.current, x, y);
    setSelected(eventOfHit(h));
  };

  const onPointerLeave = () => {
    if (drag.current) return;
    setHover(null);
    setHoverX(null);
    setTip(null);
  };

  const zoomCenter = (factor: number) => {
    const v = viewRef.current;
    setView(zoomAt(v, (v.start + v.end) / 2, factor, bounds));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const v = viewRef.current;
    const span = v.end - v.start;
    switch (e.key) {
      case 'ArrowLeft':
        setView(panBy(v, -span * 0.15, bounds));
        break;
      case 'ArrowRight':
        setView(panBy(v, span * 0.15, bounds));
        break;
      case '+':
      case '=':
        zoomCenter(0.7);
        break;
      case '-':
      case '_':
        zoomCenter(1 / 0.7);
        break;
      case '0':
        setView(fitView(bounds));
        break;
      case 'Escape':
        setSelected(null);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // Keep the view valid when bounds change (live data).
  useEffect(() => {
    setView((v) => clampView(v, bounds));
  }, [bounds]);

  const span = view.end - view.start;
  const laneSummary = model.lanes
    .map((l) => `${l.label}: ${l.spans.length + l.ticks.length + l.series.reduce((a, s) => a + s.points.length, 0)} items`)
    .join('; ');

  return (
    <div className="timeline">
      <div className="timeline-toolbar">
        <div className="tl-tools" role="group" aria-label="Zoom">
          <Button size="sm" variant="ghost" icon="zoomIn" onClick={() => zoomCenter(0.6)} aria-label="Zoom in" title="Zoom in (+)" />
          <Button size="sm" variant="ghost" icon="zoomOut" onClick={() => zoomCenter(1 / 0.6)} aria-label="Zoom out" title="Zoom out (−)" />
          <Button size="sm" variant="ghost" icon="fit" onClick={() => setView(fitView(bounds))} title="Fit all (0)">
            Fit
          </Button>
        </div>
        <div className="tl-range mono" aria-live="off">
          {fmtOffset(view.start - model.start)} → {fmtOffset(view.end - model.start)} <span className="muted">({fmtMs(span)} visible)</span>
        </div>
        <div className="tl-meta muted">{model.count.toLocaleString()} events</div>
        {focusTs !== null || highlightIds.length ? (
          <Button size="sm" variant="ghost" icon="close" onClick={onClearFocus}>
            Clear highlight
          </Button>
        ) : null}
        <div className="tl-hint muted">Scroll/pinch to zoom · drag or Shift+scroll to pan · click to inspect</div>
      </div>
      <div ref={wrapRef} className="timeline-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="timeline-canvas"
          tabIndex={0}
          role="img"
          aria-label={`Session timeline. ${laneSummary}. Use arrow keys to pan, plus and minus to zoom, 0 to fit.`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (drag.current = null)}
          onPointerLeave={onPointerLeave}
          onKeyDown={onKeyDown}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
      <FloatingTooltip state={tip} />
      <EventDetails ev={selected} origin={model.start} onClose={() => setSelected(null)} />
    </div>
  );
}

function EventDetails({ ev, origin, onClose }: { ev: PerfEvent | null; origin: number; onClose: () => void }): ReactElement {
  if (!ev) {
    return <div className="tl-details tl-details-empty muted">Click an item on the timeline to inspect its event.</div>;
  }
  return (
    <section className="tl-details" aria-label="Selected event">
      <header className="tl-details-header">
        <span className="type-pill" style={{ borderColor: eventColor(ev.type) }}>
          <span className="type-dot" style={{ background: eventColor(ev.type) }} aria-hidden="true" />
          {ev.type}
        </span>
        <span className="mono">{fmtOffset(ev.ts - origin)}</span>
        <span className="muted">{fmtDateTime(ev.ts)} · {fmtTime(ev.ts)}</span>
        <Button size="sm" variant="ghost" icon="close" onClick={onClose} aria-label="Close event details" />
      </header>
      <dl className="kv-grid">
        <dt>Duration</dt>
        <dd>{ev.duration !== null ? fmtMs(ev.duration) : 'instant'}</dd>
        <dt>Screen</dt>
        <dd>{ev.screen ?? '—'}</dd>
        <dt>Source</dt>
        <dd>{ev.source}</dd>
        <dt>Event id</dt>
        <dd className="mono">{ev.id}</dd>
      </dl>
      <div className="tl-meta-tree">
        <div className="section-label">Metadata</div>
        <JsonTree value={ev.metadata} />
      </div>
    </section>
  );
}
