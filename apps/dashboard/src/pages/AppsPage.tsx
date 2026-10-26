import { useEffect, useRef, useState, type DragEvent, type ReactElement } from 'react';
import { api, errorMessage, seg, uploadFile, type UploadHandle } from '../api/client';
import { useApi } from '../api/hooks';
import type { AppRecord, OkResponse } from '../api/types';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { useConfirm } from '../components/Confirm';
import { EmptyState, ErrorState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { LoadingBlock } from '../components/Spinner';
import { DataTable, type Column } from '../components/Table';
import { useToast } from '../components/Toast';
import type { Tone } from '../lib/colors';
import { fmtBytes, fmtDateTime, fmtRelative } from '../lib/format';
import { navigate, paths } from '../router';
import { NewSessionModal } from './NewSessionModal';

export function instrumentTone(status: AppRecord['instrumented']['status']): Tone {
  switch (status) {
    case 'ready':
      return 'good';
    case 'running':
      return 'accent';
    case 'failed':
      return 'critical';
    default:
      return 'neutral';
  }
}

const INSTRUMENT_LABEL: Record<string, string> = {
  none: 'Not built',
  running: 'Building…',
  ready: 'Instrumented',
  failed: 'Build failed',
};

function engineLabel(a: AppRecord): string {
  if (a.jsEngine === 'hermes') return 'Hermes';
  if (a.jsEngine === 'jsc') return 'JSC';
  return 'Unknown';
}

function bundleLabel(a: AppRecord): string {
  if (a.bundleFormat === 'hbc') return 'Hermes bytecode';
  if (a.bundleFormat === 'js') return 'Plain JS';
  return 'No bundle';
}

const COLUMNS: Column<AppRecord>[] = [
  {
    key: 'package',
    header: 'Package',
    sortValue: (a) => a.packageName,
    render: (a) => (
      <span className="cell-stack">
        <span className="mono strong">{a.packageName}</span>
        <span className="muted small truncate" title={a.fileName}>
          {a.fileName}
        </span>
      </span>
    ),
  },
  {
    key: 'version',
    header: 'Version',
    sortValue: (a) => a.versionCode,
    render: (a) => (a.versionName ? `${a.versionName}${a.versionCode !== null ? ` (${a.versionCode})` : ''}` : '—'),
  },
  {
    key: 'engine',
    header: 'Engine',
    sortValue: (a) => a.jsEngine,
    render: (a) => (
      <span className="cell-stack">
        <span>{a.isReactNative ? engineLabel(a) : '—'}</span>
        <span className="muted small">{bundleLabel(a)}</span>
      </span>
    ),
  },
  { key: 'size', header: 'Size', align: 'right', sortValue: (a) => a.size, render: (a) => <span className="num">{fmtBytes(a.size)}</span> },
  {
    key: 'abis',
    header: 'ABIs',
    sortValue: (a) => a.abis?.length ?? 0,
    render: (a) => <span className="mono small">{a.abis?.length ? a.abis.join(', ') : 'universal'}</span>,
  },
  {
    key: 'rn',
    header: 'React Native',
    sortValue: (a) => (a.isReactNative ? 1 : 0),
    render: (a) => (a.isReactNative ? <Badge tone="good" icon="check">Detected</Badge> : <Badge tone="warning">Not detected</Badge>),
  },
  {
    key: 'instr',
    header: 'Instrumented',
    sortValue: (a) => a.instrumented?.status,
    render: (a) => <Badge tone={instrumentTone(a.instrumented?.status ?? 'none')}>{INSTRUMENT_LABEL[a.instrumented?.status ?? 'none']}</Badge>,
  },
  {
    key: 'uploaded',
    header: 'Uploaded',
    sortValue: (a) => a.uploadedAt,
    render: (a) => <span title={fmtDateTime(a.uploadedAt)}>{fmtRelative(a.uploadedAt)}</span>,
  },
];

/** Asks for confirmation, then deletes the app. Resolves true once it is gone. */
function useDeleteApp(): (a: AppRecord, onConfirmed?: () => void) => Promise<boolean> {
  const confirm = useConfirm();
  const toast = useToast();
  return async (a, onConfirmed) => {
    const ok = await confirm({
      title: 'Delete app?',
      body: (
        <>
          Delete <span className="mono">{a.packageName}</span> ({a.fileName}) and its instrumented build? Sessions recorded with it keep their
          data.
        </>
      ),
      confirmLabel: 'Delete app',
      danger: true,
    });
    if (!ok) return false;
    onConfirmed?.();
    try {
      await api.del<OkResponse>(`/api/apps/${seg(a.id)}`);
      toast.success('App deleted');
      return true;
    } catch (err) {
      toast.error(err, 'Delete failed');
      return false;
    }
  };
}

export function AppsPage({ selectedId }: { selectedId: string | null }): ReactElement {
  const apps = useApi<AppRecord[]>('/api/apps');
  const deleteApp = useDeleteApp();
  const [sessionFor, setSessionFor] = useState<AppRecord | null>(null);
  const list = apps.data ?? [];

  const remove = async (a: AppRecord) => {
    if (!(await deleteApp(a))) return;
    apps.setData((prev) => prev?.filter((x) => x.id !== a.id));
    if (selectedId === a.id) navigate(paths.apps());
  };

  const columns: Column<AppRecord>[] = [
    ...COLUMNS,
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (a) => (
        <Button
          size="sm"
          variant="ghost"
          icon="trash"
          aria-label={`Delete app ${a.packageName}`}
          title="Delete app"
          onClick={(e) => {
            e.stopPropagation();
            void remove(a);
          }}
        />
      ),
    },
  ];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Apps</h1>
          <p className="page-sub">Upload a release or debug APK. It is analyzed locally and can be rebuilt with the performance agent injected.</p>
        </div>
        <div className="page-actions">
          <Button icon="refresh" onClick={apps.reload}>
            Refresh
          </Button>
        </div>
      </div>

      <UploadZone
        onUploaded={(rec) => {
          apps.reload();
          navigate(paths.apps(rec.id));
        }}
      />

      <div className={`split${selectedId ? ' with-detail' : ''}`}>
        <Card title="Uploaded APKs" subtitle={list.length ? `${list.length} app${list.length === 1 ? '' : 's'}` : undefined} flush>
          {apps.initialLoading ? (
            <LoadingBlock />
          ) : apps.error ? (
            <ErrorState error={errorMessage(apps.error)} onRetry={apps.reload} />
          ) : list.length === 0 ? (
            <EmptyState icon="apps" title="No apps yet">
              Drop an <span className="mono">.apk</span> above to get started. Split APK bundles (<span className="mono">.aab</span>/
              <span className="mono">.apks</span>) are not supported — build a universal APK.
            </EmptyState>
          ) : (
            <DataTable
              columns={columns}
              rows={list}
              rowKey={(a) => a.id}
              selectedKey={selectedId}
              onRowClick={(a) => navigate(paths.apps(a.id))}
              caption="Uploaded apps"
            />
          )}
        </Card>
        {selectedId ? (
          <AppDetail
            key={selectedId}
            id={selectedId}
            onChanged={apps.reload}
            onNewSession={setSessionFor}
            onDeleted={() => {
              apps.reload();
              navigate(paths.apps());
            }}
          />
        ) : null}
      </div>

      {sessionFor ? <NewSessionModal app={sessionFor} onClose={() => setSessionFor(null)} /> : null}
    </div>
  );
}

/* ------------------------------ upload zone ----------------------------- */

function UploadZone({ onUploaded }: { onUploaded: (rec: AppRecord) => void }): ReactElement {
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handle = useRef<UploadHandle<AppRecord> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  useEffect(() => () => handle.current?.abort(), []);

  const start = async (file: File) => {
    setError(null);
    if (!file.name.toLowerCase().endsWith('.apk')) {
      setError(`“${file.name}” is not an .apk file.`);
      return;
    }
    setFileName(file.name);
    setProgress(0);
    const h = uploadFile<AppRecord>('/api/apps', 'file', file, setProgress);
    handle.current = h;
    try {
      const rec = await h.promise;
      toast.success(`Uploaded ${rec.packageName ?? file.name}`);
      onUploaded(rec);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      handle.current = null;
      setProgress(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (progress !== null) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void start(file);
  };

  const uploading = progress !== null;
  const pct = Math.round((progress ?? 0) * 100);

  return (
    <div
      className={`dropzone${dragOver ? ' over' : ''}${uploading ? ' busy' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!uploading) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="dropzone-icon">
        <Icon name="upload" size={22} />
      </div>
      {uploading ? (
        <div className="dropzone-progress">
          <div className="dropzone-line">
            Uploading <span className="mono">{fileName}</span>
            <span className="num">{pct < 100 ? `${pct}%` : 'Analyzing APK…'}</span>
          </div>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Upload progress">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <Button size="sm" variant="ghost" onClick={() => handle.current?.abort()}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="dropzone-text">
          <div className="dropzone-title">Drop an APK here</div>
          <div className="muted">
            or{' '}
            <label className="link-like">
              choose a file
              <input
                ref={inputRef}
                type="file"
                accept=".apk,application/vnd.android.package-archive"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void start(f);
                }}
              />
            </label>{' '}
            · universal APKs only
          </div>
          {error ? (
            <div className="error-text" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/* ------------------------------- app detail ----------------------------- */

function AppDetail({
  id,
  onChanged,
  onNewSession,
  onDeleted,
}: {
  id: string;
  onChanged: () => void;
  onNewSession: (a: AppRecord) => void;
  onDeleted: () => void;
}): ReactElement {
  const app = useApi<AppRecord>(`/api/apps/${seg(id)}`, {
    pollMs: 1500,
    pollWhile: (d) => d?.instrumented?.status === 'running',
  });
  const deleteApp = useDeleteApp();
  const toast = useToast();
  const [busy, setBusy] = useState<'instrument' | 'delete' | null>(null);
  const prevStatus = useRef<string | null>(null);

  const status = app.data?.instrumented?.status ?? null;
  useEffect(() => {
    if (prevStatus.current === 'running' && status && status !== 'running') {
      if (status === 'ready') toast.success('Instrumented APK is ready');
      else if (status === 'failed') toast.push('Instrumented build failed — see details', 'error');
      onChanged();
    }
    prevStatus.current = status;
  }, [status, onChanged, toast]);

  if (app.initialLoading) return <Card title="App details"><LoadingBlock /></Card>;
  if (app.error && !app.data)
    return (
      <Card title="App details">
        <ErrorState error={errorMessage(app.error)} onRetry={app.reload} />
      </Card>
    );
  const a = app.data;
  if (!a) return <Card title="App details" />;

  const buildInstrumented = async () => {
    setBusy('instrument');
    try {
      const rec = await api.post<AppRecord>(`/api/apps/${seg(a.id)}/instrument`);
      app.setData(() => rec);
      app.reload(); // restarts the polling loop
      onChanged();
    } catch (err) {
      toast.error(err, 'Could not start instrumentation');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (await deleteApp(a, () => setBusy('delete'))) onDeleted();
    else setBusy(null);
  };

  const inst = a.instrumented ?? { status: 'none', strategy: null, error: null, builtAt: null, channel: null };
  const support = a.instrumentation ?? { supported: false, strategy: null, reason: 'Unknown' };

  return (
    <Card
      className="app-detail"
      title={<span className="mono">{a.packageName}</span>}
      subtitle={a.fileName}
      actions={
        <Button size="sm" variant="ghost" icon="close" onClick={() => navigate(paths.apps())} aria-label="Close details" />
      }
    >
      <div className="detail-actions">
        <Button variant="primary" icon="plus" onClick={() => onNewSession(a)}>
          New session
        </Button>
        <Button variant="danger" icon="trash" onClick={() => void remove()} loading={busy === 'delete'}>
          Delete
        </Button>
      </div>

      <dl className="kv-grid">
        <dt>Version</dt>
        <dd>
          {a.versionName ?? '—'} {a.versionCode !== null ? <span className="muted">(code {a.versionCode})</span> : null}
        </dd>
        <dt>SDK</dt>
        <dd>
          min {a.minSdk ?? '—'} · target {a.targetSdk ?? '—'}
        </dd>
        <dt>Launch activity</dt>
        <dd className="mono small break">{a.launchActivity ?? '—'}</dd>
        <dt>React Native</dt>
        <dd>{a.isReactNative ? 'Detected' : 'Not detected'}</dd>
        <dt>JS engine</dt>
        <dd>{engineLabel(a)}</dd>
        <dt>Bundle</dt>
        <dd>
          {bundleLabel(a)}
          {a.bundleSize !== null ? <span className="muted"> · {fmtBytes(a.bundleSize)}</span> : null}
        </dd>
        <dt>APK size</dt>
        <dd>{fmtBytes(a.size)}</dd>
        <dt>ABIs</dt>
        <dd className="mono small">{a.abis?.length ? a.abis.join(', ') : 'universal / none'}</dd>
        <dt>SHA-256</dt>
        <dd className="mono small break" title={a.sha256}>
          {a.sha256 ? `${a.sha256.slice(0, 16)}…` : '—'}
        </dd>
        <dt>Uploaded</dt>
        <dd>{fmtDateTime(a.uploadedAt)}</dd>
      </dl>

      <div className="subsection">
        <div className="subsection-head">
          <h3 className="subsection-title">Instrumentation</h3>
          <Badge tone={instrumentTone(inst.status)} dot={inst.status === 'running'}>
            {INSTRUMENT_LABEL[inst.status] ?? inst.status}
          </Badge>
        </div>
        <p className={`support-line ${support.supported ? 'ok' : 'no'}`}>
          <Icon name={support.supported ? 'check' : 'alert'} size={14} />
          <span>
            {support.supported ? `Supported${support.strategy ? ` (${support.strategy} strategy)` : ''}.` : 'Not supported.'} {support.reason}
          </span>
        </p>
        {inst.status === 'failed' && inst.error ? (
          <pre className="error-block" role="alert">
            {inst.error}
          </pre>
        ) : null}
        {inst.status === 'ready' ? (
          <p className="muted small">
            Built {fmtDateTime(inst.builtAt)}
            {inst.strategy ? ` · ${inst.strategy} strategy` : ''}
            {inst.channel ? (
              <>
                {' '}
                · channel <span className="mono">{inst.channel}</span>
              </>
            ) : null}
            . Re-signed with the local debug key — installing it replaces a store-signed build.
          </p>
        ) : null}
        <Button
          icon="hammer"
          onClick={() => void buildInstrumented()}
          disabled={!support.supported || inst.status === 'running'}
          loading={busy === 'instrument' || inst.status === 'running'}
        >
          {inst.status === 'ready' ? 'Rebuild instrumented APK' : 'Build instrumented APK'}
        </Button>
        {!support.supported ? (
          <p className="muted small">
            You can still profile the original APK (native startup, FPS, memory, CPU), or integrate <span className="mono">@rnpa/agent</span> in
            the app source to capture JS metrics.
          </p>
        ) : null}
      </div>
    </Card>
  );
}
