import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactElement } from 'react';
import { api, errorMessage, isAbort, seg } from '../../api/client';
import type { InputAction, OkResponse } from '../../api/types';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { fmtTime } from '../../lib/format';

interface DragState {
  id: number;
  x: number;
  y: number;
  t: number;
  button: number;
  shift: boolean;
}

const SWIPE_THRESHOLD = 0.025; // normalized distance

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function DeviceMirror({ sessionId, disabled }: { sessionId: string; disabled?: boolean }): ReactElement {
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(true);
  const [intervalSec, setIntervalSec] = useState(2);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [ripple, setRipple] = useState<{ x: number; y: number; kind: string; key: number } | null>(null);

  const urlRef = useRef<string | null>(null);
  const inflight = useRef<AbortController | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const followUp = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    const ctrl = new AbortController();
    inflight.current = ctrl;
    setLoading(true);
    try {
      const blob = await api.getBlob(`/api/sessions/${seg(sessionId)}/screenshot`, ctrl.signal);
      const next = URL.createObjectURL(blob);
      const prev = urlRef.current;
      urlRef.current = next;
      setUrl(next);
      if (prev) URL.revokeObjectURL(prev);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (err) {
      if (!isAbort(err)) setError(errorMessage(err));
    } finally {
      if (inflight.current === ctrl) inflight.current = null;
      setLoading(false);
    }
  }, [sessionId]);

  // Initial + auto refresh (paused while the tab is hidden).
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!auto) return;
    const id = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, intervalSec * 1000);
    return () => window.clearInterval(id);
  }, [auto, intervalSec, refresh]);

  // Cleanup: abort and revoke.
  useEffect(
    () => () => {
      inflight.current?.abort();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
      if (followUp.current !== null) window.clearTimeout(followUp.current);
    },
    [],
  );

  const scheduleFollowUp = () => {
    if (followUp.current !== null) window.clearTimeout(followUp.current);
    followUp.current = window.setTimeout(() => {
      followUp.current = null;
      void refresh();
    }, 600);
  };

  const send = async (action: InputAction) => {
    try {
      await api.post<OkResponse>(`/api/sessions/${seg(sessionId)}/input`, action);
      scheduleFollowUp();
    } catch (err) {
      toast.error(err, 'Input failed');
    }
  };

  const norm = (e: PointerEvent<HTMLElement>) => {
    const img = imgRef.current;
    if (!img) return null;
    const r = img.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || !url) return;
    if (e.button !== 0 && e.button !== 2) return;
    const p = norm(e);
    if (!p) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id: e.pointerId, x: p.x, y: p.y, t: performance.now(), button: e.button, shift: e.shiftKey };
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    const p = norm(e);
    if (p) setDrag({ x0: d.x, y0: d.y, x1: p.x, y1: p.y });
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d || d.id !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const p = norm(e) ?? { x: d.x, y: d.y };
    const dist = Math.hypot(p.x - d.x, p.y - d.y);
    const elapsed = performance.now() - d.t;
    let action: InputAction;
    if (dist >= SWIPE_THRESHOLD && d.button === 0) {
      action = { kind: 'swipe', x: d.x, y: d.y, x2: p.x, y2: p.y, durationMs: Math.round(Math.min(2000, Math.max(120, elapsed))) };
    } else if (d.button === 2 || d.shift || e.shiftKey) {
      action = { kind: 'long_press', x: d.x, y: d.y };
    } else {
      action = { kind: 'tap', x: d.x, y: d.y };
    }
    setRipple({ x: d.x, y: d.y, kind: action.kind, key: Date.now() });
    void send(action);
  };

  return (
    <div className="mirror">
      <div className="mirror-toolbar">
        <Checkbox checked={auto} onChange={setAuto}>
          Auto-refresh
        </Checkbox>
        <label className="inline-field">
          <span className="sr-only">Refresh interval</span>
          <select className="input input-sm" value={intervalSec} onChange={(e) => setIntervalSec(Number(e.target.value))} disabled={!auto}>
            {[1, 2, 3, 4, 5].map((s) => (
              <option key={s} value={s}>
                every {s}s
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" variant="ghost" icon="refresh" onClick={() => void refresh()} loading={loading} aria-label="Refresh screenshot" title="Refresh now" />
      </div>

      <div
        className={`mirror-frame${disabled ? ' disabled' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          dragRef.current = null;
          setDrag(null);
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {url ? (
          <>
            <img ref={imgRef} src={url} alt="Live device screen. Click to tap, drag to swipe, right-click or Shift-click to long-press." className="mirror-img" draggable={false} />
            <svg className="mirror-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              {drag && Math.hypot(drag.x1 - drag.x0, drag.y1 - drag.y0) >= SWIPE_THRESHOLD ? (
                <line x1={drag.x0 * 100} y1={drag.y0 * 100} x2={drag.x1 * 100} y2={drag.y1 * 100} className="mirror-swipe" vectorEffect="non-scaling-stroke" />
              ) : null}
            </svg>
            {ripple ? (
              <span
                key={ripple.key}
                className={`mirror-ripple ${ripple.kind}`}
                style={{ left: `${ripple.x * 100}%`, top: `${ripple.y * 100}%` }}
                onAnimationEnd={() => setRipple(null)}
                aria-hidden="true"
              />
            ) : null}
          </>
        ) : (
          <div className="mirror-placeholder">
            {loading ? <Spinner size={20} label="Loading screenshot" /> : <Icon name="devices" size={28} />}
            <span>{error ?? (loading ? 'Capturing screen…' : 'No screenshot yet')}</span>
          </div>
        )}
      </div>

      <div className="mirror-footer">
        <div className="mirror-nav" role="group" aria-label="Device navigation">
          <Button size="sm" icon="back" onClick={() => void send({ kind: 'back' })} disabled={disabled}>
            Back
          </Button>
          <Button size="sm" icon="home" onClick={() => void send({ kind: 'home' })} disabled={disabled}>
            Home
          </Button>
        </div>
        <span className="muted small">
          {error && url ? <span className="error-text">{error}</span> : updatedAt ? `Updated ${fmtTime(updatedAt)}` : null}
        </span>
      </div>
      <p className="mirror-hint muted small">Click = tap · drag = swipe · right-click / Shift-click = long-press</p>
    </div>
  );
}
