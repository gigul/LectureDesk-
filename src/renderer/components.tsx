import React from 'react';
import { X, LoaderCircle, ChevronDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { languageNames, type TextKey } from './i18n';
import type { Language } from '../shared/types';

export type T = (key: TextKey) => string;
export function Button({
  icon: Icon,
  children,
  variant = 'secondary',
  busy,
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: LucideIcon;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  busy?: boolean;
}) {
  return (
    <button {...props} className={`button ${variant} ${className}`} disabled={props.disabled || busy}>
      {busy ? <LoaderCircle className="spin" size={16} /> : Icon ? <Icon size={16} /> : null}
      {children}
    </button>
  );
}
export function IconButton({
  icon: Icon,
  label,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string }) {
  return (
    <button
      {...props}
      type="button"
      title={label}
      aria-label={label}
      className={`icon-button ${props.className || ''}`}
    >
      <Icon size={18} />
    </button>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="select-wrap">
      <select {...props} />
      <ChevronDown size={14} />
    </span>
  );
}
export function Languages({
  value,
  onChange,
  auto,
  t,
}: {
  value: string;
  onChange: (v: Language | 'auto') => void;
  auto?: boolean;
  t: T;
}) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as Language | 'auto')}>
      {auto && <option value="auto">{t('autoDetect')}</option>}
      {Object.entries(languageNames).map(([id, label]) => (
        <option value={id} key={id}>
          {label}
        </option>
      ))}
    </Select>
  );
}
export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`toggle-field ${disabled ? 'disabled' : ''}`}>
      <span>
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle" aria-hidden="true" />
    </label>
  );
}
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide = false,
  t,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
  t: T;
}) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;
  React.useEffect(() => {
    const old = document.activeElement as HTMLElement | null;
    const node = rootRef.current;
    const focusable = () =>
      Array.from(
        node?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
        ) || [],
      );
    focusable()[0]?.focus();
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab') {
        const nodes = focusable();
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handle);
    return () => {
      document.removeEventListener('keydown', handle);
      old?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={rootRef}
      >
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <IconButton icon={X} label={t('close')} onClick={onClose} />
        </header>
        <div className="modal-content">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}
export function Empty({
  icon: Icon,
  title,
  body,
  children,
  compact = false,
}: {
  icon: LucideIcon;
  title: string;
  body?: string;
  children?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty ${compact ? 'compact' : ''}`}>
      <div className="empty-icon">
        <Icon size={compact ? 25 : 34} />
      </div>
      <h2>{title}</h2>
      {body && <p>{body}</p>}
      {children && <div className="empty-actions">{children}</div>}
    </div>
  );
}

// Markdown remains plain React nodes: imported content cannot execute HTML, scripts, or commands.
export function Markdown({ text, onLink }: { text: string; onLink?: (url: string) => void }) {
  function inline(line: string): React.ReactNode[] {
    return line.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g).map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
      if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
      const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      if (link)
        return (
          <button className="text-link" key={i} onClick={() => onLink?.(link[2])}>
            {link[1]}
          </button>
        );
      return part;
    });
  }
  const lines = text.split('\n');
  const result: React.ReactNode[] = [];
  let code: string[] | null = null;
  lines.forEach((line, i) => {
    if (line.startsWith('```')) {
      if (code) {
        result.push(
          <pre key={i}>
            <code>{code.join('\n')}</code>
          </pre>,
        );
        code = null;
      } else code = [];
      return;
    }
    if (code) {
      code.push(line);
      return;
    }
    if (!line.trim()) {
      result.push(<div key={i} className="paragraph-gap" />);
      return;
    }
    const h = line.match(/^(#{1,4})\s+(.+)/);
    if (h) {
      const Tag = `h${Math.min(h[1].length + 1, 5)}` as 'h2' | 'h3' | 'h4' | 'h5';
      result.push(<Tag key={i}>{inline(h[2])}</Tag>);
    } else if (/^[-*]\s+/.test(line))
      result.push(
        <div className="markdown-bullet" key={i}>
          <span>•</span>
          <span>{inline(line.replace(/^[-*]\s+/, ''))}</span>
        </div>,
      );
    else if (/^\d+\.\s+/.test(line))
      result.push(
        <div className="markdown-bullet" key={i}>
          <span>{line.match(/^\d+\./)?.[0]}</span>
          <span>{inline(line.replace(/^\d+\.\s+/, ''))}</span>
        </div>,
      );
    else if (line.startsWith('>'))
      result.push(<blockquote key={i}>{inline(line.replace(/^>\s?/, ''))}</blockquote>);
    else result.push(<p key={i}>{inline(line)}</p>);
  });
  if (code !== null) {
    const remainder = code as string[];
    result.push(
      <pre key="unfinished">
        <code>{remainder.join('\n')}</code>
      </pre>,
    );
  }
  return <div className="markdown">{result}</div>;
}
