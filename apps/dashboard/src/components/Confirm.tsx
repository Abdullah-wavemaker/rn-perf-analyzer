import { createContext, useCallback, useContext, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn>(() => Promise.resolve(false));

export function ConfirmProvider({ children }: { children: ReactNode }): ReactElement {
  const [pending, setPending] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    resolver.current?.(false);
    setPending(opts);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = (v: boolean) => {
    resolver.current?.(v);
    resolver.current = null;
    setPending(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending ? (
        <Modal
          title={pending.title}
          onClose={() => settle(false)}
          width={460}
          footer={
            <>
              <Button variant="ghost" onClick={() => settle(false)}>
                Cancel
              </Button>
              <Button variant={pending.danger ? 'danger' : 'primary'} onClick={() => settle(true)} data-autofocus>
                {pending.confirmLabel ?? 'Confirm'}
              </Button>
            </>
          }
        >
          <div className="confirm-body">{pending.body}</div>
        </Modal>
      ) : null}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}
