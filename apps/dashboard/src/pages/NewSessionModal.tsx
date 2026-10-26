import { useEffect, useState, type ReactElement } from 'react';
import { api, errorMessage } from '../api/client';
import { useApi } from '../api/hooks';
import type { AppRecord, CreateSessionBody, Device, Session, Variant } from '../api/types';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState, ErrorState } from '../components/EmptyState';
import { Field } from '../components/Field';
import { Modal } from '../components/Modal';
import { LoadingBlock } from '../components/Spinner';
import { navigate, paths } from '../router';
import { AvdList, DeviceHelp, deviceStateTone } from './DevicesPage';

export function NewSessionModal({ app: fixedApp, onClose }: { app?: AppRecord; onClose: () => void }): ReactElement {
  const apps = useApi<AppRecord[]>(fixedApp ? null : '/api/apps');
  const [fastPoll, setFastPoll] = useState(false);
  const devices = useApi<Device[]>('/api/devices', { pollMs: fastPoll ? 3000 : 8000 });
  const [appId, setAppId] = useState<string>(fixedApp?.id ?? '');
  const [serial, setSerial] = useState<string>('');
  const [variant, setVariant] = useState<Variant>('original');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const app = fixedApp ?? apps.data?.find((a) => a.id === appId);
  const instrumentedReady = app?.instrumented?.status === 'ready';
  const firstOnline = (devices.data ?? []).find((d) => d.state === 'device')?.serial;

  // Sensible defaults.
  useEffect(() => {
    if (!appId && apps.data?.[0]) setAppId(apps.data[0].id);
  }, [apps.data, appId]);
  useEffect(() => {
    if (!serial && firstOnline) setSerial(firstOnline);
  }, [firstOnline, serial]);
  useEffect(() => {
    setVariant(instrumentedReady ? 'instrumented' : 'original');
  }, [instrumentedReady, app?.id]);

  const submit = async () => {
    if (!app || !serial) return;
    setSubmitting(true);
    setError(null);
    try {
      const body: CreateSessionBody = { appId: app.id, serial, variant };
      if (name.trim()) body.name = name.trim().slice(0, 120);
      const s = await api.post<Session>('/api/sessions', body);
      onClose();
      navigate(paths.session(s.id, 'control'));
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="New session"
      onClose={onClose}
      width={620}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="play" onClick={() => void submit()} loading={submitting} disabled={!app || !serial}>
            Create session
          </Button>
        </>
      }
    >
      <form
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {fixedApp ? (
          <div className="form-static">
            <span className="field-label">App</span>
            <span className="mono">{fixedApp.packageName}</span>
            <span className="muted"> {fixedApp.versionName ?? ''}</span>
          </div>
        ) : (
          <Field label="App">
            {(id) =>
              apps.initialLoading ? (
                <LoadingBlock />
              ) : (apps.data ?? []).length === 0 ? (
                <p className="muted">
                  No apps uploaded. <a href={paths.apps()} onClick={onClose}>Upload an APK</a> first.
                </p>
              ) : (
                <select id={id} className="input" value={appId} onChange={(e) => setAppId(e.target.value)}>
                  {(apps.data ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.packageName} {a.versionName ? `(${a.versionName})` : ''}
                    </option>
                  ))}
                </select>
              )
            }
          </Field>
        )}

        <fieldset className="fieldset">
          <legend className="field-label">Device</legend>
          {devices.initialLoading ? (
            <LoadingBlock label="Querying adb…" />
          ) : devices.error ? (
            <ErrorState error={errorMessage(devices.error)} onRetry={devices.reload} />
          ) : (devices.data ?? []).length === 0 ? (
            <EmptyState icon="devices" title="No devices connected" compact>
              <DeviceHelp />
            </EmptyState>
          ) : (
            <div className="choice-list" role="radiogroup" aria-label="Device">
              {(devices.data ?? []).map((d) => {
                const disabled = d.state !== 'device';
                return (
                  <label key={d.serial} className={`choice${serial === d.serial ? ' checked' : ''}${disabled ? ' disabled' : ''}`}>
                    <input type="radio" name="device" value={d.serial} checked={serial === d.serial} disabled={disabled} onChange={() => setSerial(d.serial)} />
                    <span className="choice-main">
                      <span className="choice-title">{d.model ?? d.serial}</span>
                      <span className="choice-sub mono">
                        {d.serial}
                        {d.release ? ` · Android ${d.release}` : ''}
                        {d.sdk ? ` (API ${d.sdk})` : ''}
                        {d.abi ? ` · ${d.abi}` : ''}
                      </span>
                    </span>
                    <Badge tone={deviceStateTone(d.state)}>{d.isEmulator ? `emulator · ${d.state}` : d.state}</Badge>
                  </label>
                );
              })}
            </div>
          )}
          <details className="avd-details">
            <summary>Start an emulator</summary>
            <AvdList
              onStarted={() => {
                setFastPoll(true);
                window.setTimeout(() => setFastPoll(false), 90_000);
              }}
            />
          </details>
        </fieldset>

        <fieldset className="fieldset">
          <legend className="field-label">Build variant</legend>
          <div className="choice-list" role="radiogroup" aria-label="Build variant">
            <label className={`choice${variant === 'original' ? ' checked' : ''}`}>
              <input type="radio" name="variant" checked={variant === 'original'} onChange={() => setVariant('original')} />
              <span className="choice-main">
                <span className="choice-title">Original APK</span>
                <span className="choice-sub">Native metrics only: startup, FPS, memory, CPU, crashes — unless the app already bundles @rnpa/agent.</span>
              </span>
            </label>
            <label className={`choice${variant === 'instrumented' ? ' checked' : ''}${!instrumentedReady ? ' disabled' : ''}`}>
              <input
                type="radio"
                name="variant"
                checked={variant === 'instrumented'}
                disabled={!instrumentedReady}
                onChange={() => setVariant('instrumented')}
              />
              <span className="choice-main">
                <span className="choice-title">Instrumented APK</span>
                <span className="choice-sub">
                  {instrumentedReady
                    ? 'Adds JS metrics: screens, API calls, long tasks, renders, timers.'
                    : 'Build the instrumented APK on the Apps page first.'}
                </span>
              </span>
            </label>
          </div>
        </fieldset>

        <Field label="Session name (optional)">
          {(id) => (
            <input id={id} className="input" value={name} maxLength={120} placeholder="e.g. Checkout flow, cold cache" onChange={(e) => setName(e.target.value)} />
          )}
        </Field>
        {error ? (
          <div className="error-text" role="alert">
            {error}
          </div>
        ) : null}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
