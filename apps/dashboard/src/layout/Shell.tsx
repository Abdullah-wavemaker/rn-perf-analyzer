import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useApi } from '../api/hooks';
import type { EnvInfo, ToolName } from '../api/types';
import { errorMessage } from '../api/client';
import { Icon, type IconName } from '../components/Icon';
import { Spinner } from '../components/Spinner';
import { paths, type Route } from '../router';

const NAV: { id: Route['name']; label: string; href: string; icon: IconName; match: Route['name'][] }[] = [
  { id: 'sessions', label: 'Sessions', href: paths.sessions(), icon: 'sessions', match: ['sessions', 'session'] },
  { id: 'apps', label: 'Apps', href: paths.apps(), icon: 'apps', match: ['apps'] },
  { id: 'devices', label: 'Devices', href: paths.devices(), icon: 'devices', match: ['devices'] },
  { id: 'journeys', label: 'Journeys', href: paths.journeys(), icon: 'journeys', match: ['journeys'] },
];

export function Shell({ route, children }: { route: Route; children: ReactNode }): ReactElement {
  const env = useApi<EnvInfo>('/api/env');
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="bolt" size={16} />
          </span>
          <span className="brand-text">
            <span className="brand-name">RN Perf Analyzer</span>
            <span className="brand-sub">{env.data?.version ? `v${env.data.version}` : 'local devtool'}</span>
          </span>
        </div>
        <nav aria-label="Primary" className="nav">
          {NAV.map((n) => {
            const active = n.match.includes(route.name);
            return (
              <a key={n.id} href={n.href} className={`nav-item${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined}>
                <Icon name={n.icon} size={16} />
                {n.label}
              </a>
            );
          })}
        </nav>
        <div className="sidebar-foot muted">
          Data stays on this machine.
          {env.data?.dataDir ? (
            <div className="mono truncate" title={env.data.dataDir}>
              {env.data.dataDir}
            </div>
          ) : null}
        </div>
      </aside>
      <div className="main-col">
        <header className="topbar">
          <div className="topbar-title">{titleFor(route)}</div>
          <div className="topbar-right">
            <EnvStatus env={env.data} loading={env.initialLoading} error={env.error} onRefresh={env.reload} />
          </div>
        </header>
        <main id="main" className="main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}

function titleFor(route: Route): string {
  switch (route.name) {
    case 'sessions':
      return 'Sessions';
    case 'session':
      return 'Session';
    case 'apps':
      return 'Apps';
    case 'devices':
      return 'Devices';
    case 'journeys':
      return 'Journeys';
    default:
      return 'Not found';
  }
}

const TOOLS: { id: ToolName; label: string; purpose: string; required: boolean }[] = [
  { id: 'adb', label: 'adb', purpose: 'Device control, install, collectors', required: true },
  { id: 'apksigner', label: 'apksigner', purpose: 'Re-signing instrumented APKs', required: true },
  { id: 'zipalign', label: 'zipalign', purpose: 'Aligning instrumented APKs', required: true },
  { id: 'keytool', label: 'keytool', purpose: 'Generating the debug signing key', required: true },
  { id: 'apktool', label: 'apktool', purpose: 'Only needed for Hermes-bytecode (loader) instrumentation', required: false },
  { id: 'emulator', label: 'emulator', purpose: 'Starting Android Virtual Devices', required: false },
];

function EnvStatus({
  env,
  loading,
  error,
  onRefresh,
}: {
  env: EnvInfo | undefined;
  loading: boolean;
  error: unknown;
  onRefresh: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const missingRequired = env ? TOOLS.filter((t) => t.required && !env.tools?.[t.id]?.available) : [];
  const missingOptional = env ? TOOLS.filter((t) => !t.required && !env.tools?.[t.id]?.available) : [];
  const tone = error ? 'critical' : !env ? 'neutral' : missingRequired.length ? 'critical' : missingOptional.length ? 'warning' : 'good';
  const summary = error
    ? 'Server unreachable'
    : !env
      ? 'Checking environment'
      : missingRequired.length
        ? `${missingRequired.length} required tool${missingRequired.length > 1 ? 's' : ''} missing`
        : missingOptional.length
          ? `Ready · ${missingOptional.length} optional missing`
          : 'Environment ready';

  return (
    <div className="env-status" ref={wrapRef}>
      <button type="button" className={`env-button tone-${tone}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        {loading ? <Spinner size={12} /> : <span className={`status-dot tone-${tone}`} aria-hidden="true" />}
        <span>{summary}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open ? (
        <div className="popover env-popover" role="dialog" aria-label="Environment health">
          <div className="popover-header">
            <span className="popover-title">Host toolchain</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh}>
              <Icon name="refresh" size={14} />
              <span className="btn-label">Re-check</span>
            </button>
          </div>
          {error ? <p className="error-text">{errorMessage(error)}</p> : null}
          {env ? (
            <ul className="tool-list">
              {TOOLS.map((t) => {
                const st = env.tools?.[t.id];
                const ok = Boolean(st?.available);
                return (
                  <li key={t.id} className="tool-row">
                    <span className={`tool-icon ${ok ? 'ok' : t.required ? 'missing' : 'optional'}`}>
                      <Icon name={ok ? 'check' : t.required ? 'close' : 'info'} size={12} title={ok ? 'available' : 'missing'} />
                    </span>
                    <span className="tool-main">
                      <span className="tool-name mono">{t.label}</span>
                      <span className="tool-purpose">{t.purpose}</span>
                      {ok && (st?.version || st?.path) ? (
                        <span className="tool-path mono truncate" title={st?.path ?? undefined}>
                          {st?.version ? `${st.version} · ` : ''}
                          {st?.path ?? ''}
                        </span>
                      ) : null}
                    </span>
                    <span className={`tool-state ${ok ? 'ok' : t.required ? 'missing' : 'optional'}`}>
                      {ok ? 'found' : t.required ? 'missing' : 'optional'}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {env && (missingRequired.length || missingOptional.length) ? (
            <p className="popover-note">
              Install the Android SDK build-tools and platform-tools and make sure they are on <span className="mono">PATH</span> (or set{' '}
              <span className="mono">ANDROID_HOME</span>), then run <span className="mono">rnpa doctor</span>. apktool is only needed to
              instrument apps that ship Hermes bytecode.
            </p>
          ) : null}
          {env?.metroInspectorUrl ? (
            <p className="popover-note">
              Metro inspector: <span className="mono">{env.metroInspectorUrl}</span>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
