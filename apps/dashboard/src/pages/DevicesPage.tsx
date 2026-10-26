import { useState, type ReactElement } from 'react';
import { api, errorMessage, seg } from '../api/client';
import { useApi } from '../api/hooks';
import type { Device, OkResponse } from '../api/types';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { EmptyState, ErrorState } from '../components/EmptyState';
import { LoadingBlock } from '../components/Spinner';
import { DataTable, type Column } from '../components/Table';
import { useToast } from '../components/Toast';
import type { Tone } from '../lib/colors';

export function deviceStateTone(state: string): Tone {
  if (state === 'device') return 'good';
  if (state === 'unauthorized') return 'warning';
  if (state === 'offline') return 'critical';
  return 'neutral';
}

export function deviceLabel(d: Device): string {
  return d.model ? `${d.model} (${d.serial})` : d.serial;
}

const DEVICE_COLUMNS: Column<Device>[] = [
  {
    key: 'serial',
    header: 'Serial',
    sortValue: (d) => d.serial,
    render: (d) => (
      <span className="cell-stack">
        <span className="mono">{d.serial}</span>
        {d.isEmulator ? <span className="muted small">Emulator</span> : <span className="muted small">Physical</span>}
      </span>
    ),
  },
  { key: 'model', header: 'Model', sortValue: (d) => d.model, render: (d) => d.model ?? '—' },
  {
    key: 'android',
    header: 'Android',
    sortValue: (d) => d.sdk,
    render: (d) => (d.release || d.sdk ? `${d.release ?? '?'} (API ${d.sdk ?? '?'})` : '—'),
  },
  { key: 'abi', header: 'ABI', sortValue: (d) => d.abi, render: (d) => <span className="mono">{d.abi ?? '—'}</span> },
  {
    key: 'screen',
    header: 'Screen',
    sortValue: (d) => (d.screen ? d.screen.width * d.screen.height : null),
    render: (d) =>
      d.screen ? (
        <span className="mono">
          {d.screen.width}×{d.screen.height}
          {d.screen.density ? ` @${d.screen.density}dpi` : ''}
        </span>
      ) : (
        '—'
      ),
  },
  {
    key: 'state',
    header: 'State',
    sortValue: (d) => d.state,
    render: (d) => (
      <Badge tone={deviceStateTone(d.state)} dot>
        {d.state}
      </Badge>
    ),
  },
];

export function DeviceHelp(): ReactElement {
  return (
    <>
      Connect an Android device with USB debugging enabled (and accept the RSA prompt on the device), or start an emulator below. Devices
      come from <span className="mono">adb devices</span>.
    </>
  );
}

export function AvdList({ onStarted }: { onStarted?: () => void }): ReactElement {
  const avds = useApi<string[]>('/api/avds');
  const toast = useToast();
  const [starting, setStarting] = useState<string | null>(null);

  const start = async (name: string) => {
    setStarting(name);
    try {
      await api.post<OkResponse>(`/api/avds/${seg(name)}/start`);
      toast.success(`Starting emulator “${name}” — it appears in the device list once booted.`);
      onStarted?.();
    } catch (err) {
      toast.error(err, 'Could not start emulator');
    } finally {
      setStarting(null);
    }
  };

  if (avds.initialLoading) return <LoadingBlock label="Loading AVDs…" />;
  if (avds.error) return <ErrorState error={errorMessage(avds.error)} onRetry={avds.reload} />;
  const list = avds.data ?? [];
  if (list.length === 0)
    return (
      <EmptyState icon="emulator" title="No Android Virtual Devices" compact>
        Create one in Android Studio's Device Manager (or with <span className="mono">avdmanager</span>). The{' '}
        <span className="mono">emulator</span> binary must be available.
      </EmptyState>
    );
  return (
    <ul className="avd-list">
      {list.map((name) => (
        <li key={name} className="avd-row">
          <span className="avd-name">
            <span className="mono">{name}</span>
          </span>
          <Button size="sm" icon="play" loading={starting === name} onClick={() => void start(name)}>
            Start emulator
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function DevicesPage(): ReactElement {
  const [fastPoll, setFastPoll] = useState(false);
  const devices = useApi<Device[]>('/api/devices', { pollMs: fastPoll ? 3000 : 10_000 });

  const onStarted = () => {
    setFastPoll(true);
    window.setTimeout(() => setFastPoll(false), 90_000);
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Devices</h1>
          <p className="page-sub">Android devices and emulators visible to adb.</p>
        </div>
        <div className="page-actions">
          <Button icon="refresh" onClick={devices.reload} loading={devices.loading && !devices.initialLoading}>
            Refresh
          </Button>
        </div>
      </div>

      <Card title="Connected devices" flush>
        {devices.initialLoading ? (
          <LoadingBlock label="Querying adb…" />
        ) : devices.error ? (
          <ErrorState error={errorMessage(devices.error)} onRetry={devices.reload} />
        ) : (devices.data ?? []).length === 0 ? (
          <EmptyState icon="devices" title="No devices connected">
            <DeviceHelp />
          </EmptyState>
        ) : (
          <DataTable columns={DEVICE_COLUMNS} rows={devices.data ?? []} rowKey={(d) => d.serial} initialSort={{ key: 'state', dir: 'asc' }} caption="Connected devices" />
        )}
      </Card>

      <Card title="Android Virtual Devices" subtitle="Emulators configured on this machine">
        <AvdList onStarted={onStarted} />
      </Card>
    </div>
  );
}
