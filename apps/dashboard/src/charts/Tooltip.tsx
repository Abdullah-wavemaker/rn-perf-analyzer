import { useCallback, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface TooltipState {
  x: number;
  y: number;
  content: ReactNode;
}

/** Viewport-positioned tooltip (DOM, text only). Flips to stay on screen. */
export function FloatingTooltip({ state }: { state: TooltipState | null }): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!state || !ref.current) {
      setPos(null);
      return;
    }
    const r = ref.current.getBoundingClientRect();
    const pad = 12;
    let left = state.x + pad;
    let top = state.y + pad;
    if (left + r.width > window.innerWidth - 8) left = state.x - r.width - pad;
    if (top + r.height > window.innerHeight - 8) top = state.y - r.height - pad;
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [state]);

  if (!state) return null;
  return createPortal(
    <div
      ref={ref}
      className="chart-tooltip"
      role="tooltip"
      style={{ left: pos?.left ?? state.x + 12, top: pos?.top ?? state.y + 12, visibility: pos ? 'visible' : 'hidden' }}
    >
      {state.content}
    </div>,
    document.body,
  );
}

export function useTooltip(): {
  tip: TooltipState | null;
  show: (x: number, y: number, content: ReactNode) => void;
  hide: () => void;
} {
  const [tip, setTip] = useState<TooltipState | null>(null);
  const show = useCallback((x: number, y: number, content: ReactNode) => setTip({ x, y, content }), []);
  const hide = useCallback(() => setTip(null), []);
  return { tip, show, hide };
}

/** One tooltip row: line key + value (strong) + series label. */
export function TipRow({ color, label, value }: { color?: string; label: string; value: string }): ReactElement {
  return (
    <div className="tip-row">
      {color ? <span className="tip-key" style={{ background: color }} aria-hidden="true" /> : null}
      <span className="tip-value">{value}</span>
      <span className="tip-label">{label}</span>
    </div>
  );
}

export function TipTitle({ children }: { children: ReactNode }): ReactElement {
  return <div className="tip-title">{children}</div>;
}
