import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/* ---------------------------------------------------------------------------
 * Small presentational pieces shared across screens.
 * ------------------------------------------------------------------------- */

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'accent';
  title?: string;
}): ReactNode {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Spinner({ size = 14 }: { size?: number }): ReactNode {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden />;
}

export function ProgressBar({ value, max, indeterminate }: { value: number; max: number | null; indeterminate?: boolean }): ReactNode {
  const percent = max && max > 0 ? Math.min(100, Math.round((value / max) * 100)) : null;
  return (
    <div className={`progress ${indeterminate || percent == null ? 'progress-indeterminate' : ''}`}>
      <div className="progress-fill" style={percent != null ? { width: `${percent}%` } : undefined} />
    </div>
  );
}

export function Card({
  children,
  className = '',
  ...rest
}: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>): ReactNode {
  return (
    <div className={`card ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}): ReactNode {
  return (
    <button
      type="button"
      className={`toggle ${checked ? 'toggle-on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  );
}

export function StatusDot({ status }: { status: 'pass' | 'warn' | 'fail' | 'skip' }): ReactNode {
  const label = { pass: 'ok', warn: 'warning', fail: 'failed', skip: 'not checked' }[status];
  return <span className={`status-dot status-${status}`} title={label} aria-label={label} />;
}

/* ---------------------------------------------------------------- toasts --- */

export interface Toast {
  id: number;
  tone: 'info' | 'good' | 'bad';
  message: string;
}

interface ToastContextValue {
  push: (message: string, tone?: Toast['tone']) => void;
}

const ToastContext = createContext<ToastContextValue>({ push: () => undefined });

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, tone, message }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 6000);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
