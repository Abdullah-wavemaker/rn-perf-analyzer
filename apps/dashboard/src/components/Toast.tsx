import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Icon } from './Icon';
import { errorMessage } from '../api/client';

export type ToastKind = 'info' | 'success' | 'error';

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  push: (message: string, kind?: ToastKind) => void;
  error: (err: unknown, prefix?: string) => void;
  success: (message: string) => void;
}

const ToastContext = createContext<ToastApi>({ push: () => undefined, error: () => undefined, success: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      const id = nextId.current++;
      setItems((xs) => [...xs.slice(-4), { id, kind, message }]);
      window.setTimeout(() => dismiss(id), kind === 'error' ? 8000 : 4000);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      error: (err, prefix) => push(prefix ? `${prefix}: ${errorMessage(err)}` : errorMessage(err), 'error'),
      success: (m) => push(m, 'success'),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-region" role="region" aria-label="Notifications" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <Icon name={t.kind === 'error' ? 'alert' : t.kind === 'success' ? 'check' : 'info'} size={16} />
            <span className="toast-msg">{t.message}</span>
            <button type="button" className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss notification">
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}
