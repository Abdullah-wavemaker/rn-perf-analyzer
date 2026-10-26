import { useId, type ReactElement, type ReactNode, type InputHTMLAttributes } from 'react';

/** Labelled input row. */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode }): ReactElement {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      {children(id)}
      {hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  label,
  ...rest
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  label: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'min' | 'max' | 'type'>): ReactElement {
  return (
    <input
      type="number"
      className="input input-num"
      value={Number.isFinite(value) ? value : ''}
      min={min}
      max={max}
      aria-label={label}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, Math.round(n))));
      }}
      {...rest}
    />
  );
}

export function Checkbox({ checked, onChange, children, disabled }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean }): ReactElement {
  return (
    <label className={`checkbox${disabled ? ' disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}
