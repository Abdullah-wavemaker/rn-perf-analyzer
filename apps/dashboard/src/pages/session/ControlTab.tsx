import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import { ApiError, api, seg } from '../../api/client';
import { useApi, useNow } from '../../api/hooks';
import type { SessionStream } from '../../api/sse';
import type { Journey, OkResponse, ProfileResult, Session, StartupResult } from '../../api/types';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { useConfirm } from '../../components/Confirm';
import { Checkbox, NumberInput } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { fmtClock, fmtCompact, fmtMs, fmtRelative } from '../../lib/format';
import { journeyDuration } from '../JourneysPage';
import { DeviceMirror } from './DeviceMirror';
import { LiveFeed, LogPanel } from './LiveFeed';

export const ACTIVITY_LABEL: Record<string, string> = {
  installing: 'Installing app…',
  launching: 'Launching app…',
  benchmark: 'Running startup benchmark…',
  exploring: 'Auto-exploring the app…',
  replaying: 'Replaying journey…',
  profiling: 'CPU profiling (CDP)…',
};

const MAX_PROFILE_BYTES = 64 * 1024 * 1024;

type BusyKey =
  | 'install'
  | 'launch'
  | 'hot'
  | 'bench'
  | 'record'
  | 'mark'
  | 'journey'
  | 'replay'
  | 'explore'
  | 'cancel'
  | 'profile'
  | 'cdp';

export function ControlTab({
  session,
  stream,
  onSession,
}: {
  session: Session;
  stream: SessionStream;
  onSession: (s: Session) => void;
}): ReactElement {
  const toast = useToast();
  const confirm = useConfirm();
  const base = `/api/sessions/${seg(session.id)}`;
  const [busy, setBusy] = useState<BusyKey | null>(null);
  const [grantPermissions, setGrantPermissions] = useState(true);
  const [lastLaunch, setLastLaunch] = useState<StartupResult | null>(null);
  const [iterations, setIterations] = useState(5);
  const [includeHot, setIncludeHot] = useState(true);
  const [benchRuns, setBenchRuns] = useState<StartupResult[] | null>(null);
  const [markName, setMarkName] = useState('');
  const [journeyName, setJourneyName] = useState('');
  const [repeat, setRepeat] = useState(1);
  const [maxSteps, setMaxSteps] = useState(50);
  const [maxDuration, setMaxDuration] = useState(120);
  const [cdpRunning, setCdpRunning] = useState(false);
  const profileInput = useRef<HTMLInputElement>(null);

  const journeys = useApi<Journey[]>('/api/journeys');
  const appJourneys = (journeys.data ?? []).filter((j) => j.packageName === session.packageName);

  const recording = session.status === 'recording';
  const now = useNow(1000, recording);
  const elapsed = recording && session.recordingStartedAt ? now - session.recordingStartedAt : null;
  const activity = session.activity;
  const blocked = activity !== null;

  async function run<T>(key: BusyKey, fn: () => Promise<T>, errPrefix: string): Promise<T | undefined> {
    setBusy(key);
    try {
      return await fn();
    } catch (err) {
      toast.error(err, errPrefix);
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  /* -------------------------------- install ------------------------------- */
  const install = async (replace = false): Promise<void> => {
    setBusy('install');
    try {
      await api.post<OkResponse>(`${base}/install`, { replace, grantPermissions });
      toast.success(`Installed ${session.variant} build`);
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'SIGNATURE_MISMATCH' || err.status === 409) && !replace) {
        setBusy(null);
        const ok = await confirm({
          title: 'Replace the installed app?',
          body: (
            <>
              <p>
                <span className="mono">{session.packageName}</span> is already installed on the device but signed with a different key (for example a
                Play Store build, or the original vs. instrumented variant).
              </p>
              <p>
                Android cannot update across signing keys, so replacing it <strong>uninstalls the existing app and wipes its data</strong> (logins,
                caches, local databases) before installing this build.
              </p>
            </>
          ),
          confirmLabel: 'Uninstall & replace',
          danger: true,
        });
        if (ok) return install(true);
        return;
      }
      toast.error(err, 'Install failed');
    } finally {
      setBusy((b) => (b === 'install' ? null : b));
    }
  };

  /* ------------------------------ lifecycle ------------------------------ */
  const launch = () =>
    run('launch', async () => {
      const r = await api.post<StartupResult>(`${base}/launch`, { cold: true });
      setLastLaunch(r);
    }, 'Launch failed');

  const hotStart = () =>
    run('hot', async () => {
      const r = await api.post<StartupResult>(`${base}/hot-start`);
      setLastLaunch(r);
    }, 'Hot start failed');

  const bench = () =>
    run('bench', async () => {
      setBenchRuns(null);
      const r = await api.post<{ runs: StartupResult[] }>(`${base}/startup-benchmark`, { iterations, includeHot });
      setBenchRuns(Array.isArray(r?.runs) ? r.runs : []);
      toast.success('Startup benchmark finished — see the Startup tab');
    }, 'Benchmark failed');

  const toggleRecording = () =>
    run('record', async () => {
      const s = await api.post<Session>(`${base}/record/${recording ? 'stop' : 'start'}`);
      if (s && typeof s === 'object' && 'id' in s) onSession(s);
    }, recording ? 'Could not stop recording' : 'Could not start recording');

  const addMark = () =>
    run('mark', async () => {
      const name = markName.trim() || `Mark ${new Date().toLocaleTimeString()}`;
      await api.post<OkResponse>(`${base}/marks`, { name: name.slice(0, 120) });
      setMarkName('');
      toast.success(`Mark “${name}” added`);
    }, 'Could not add mark');

  /* ------------------------------- journeys ------------------------------ */
  const startJourney = () =>
    run('journey', async () => {
      const name = journeyName.trim() || `Journey ${new Date().toLocaleString()}`;
      const s = await api.post<Session>(`${base}/journey-recording/start`, { name: name.slice(0, 120) });
      if (s && typeof s === 'object' && 'id' in s) onSession(s);
    }, 'Could not start journey recording');

  const stopJourney = () =>
    run('journey', async () => {
      const j = await api.post<Journey>(`${base}/journey-recording/stop`);
      setJourneyName('');
      journeys.reload();
      toast.success(`Saved journey “${j?.name ?? ''}” (${j?.steps?.length ?? 0} steps)`);
    }, 'Could not stop journey recording');

  const replay = (j: Journey) =>
    run('replay', async () => {
      await api.post<OkResponse>(`${base}/journeys/${seg(j.id)}/replay`, { repeat });
      toast.push(`Replaying “${j.name}” ×${repeat}`);
    }, 'Replay failed');

  const explore = () =>
    run('explore', async () => {
      await api.post<OkResponse>(`${base}/explore`, { maxSteps, maxDurationSec: maxDuration });
      toast.push('Auto-explore started');
    }, 'Could not start auto-explore');

  const cancel = () =>
    run('cancel', async () => {
      await api.post<OkResponse>(`${base}/cancel`);
    }, 'Cancel failed');

  /* ------------------------------- profiling ----------------------------- */
  const importProfile = (file: File) =>
    run('profile', async () => {
      if (file.size > MAX_PROFILE_BYTES) throw new Error('Profile is larger than 64 MB');
      const r = await api.postRaw<ProfileResult>(`${base}/profile`, file, 'application/json');
      toast.success(`Imported ${r?.functions ?? 0} functions from ${file.name}`);
      if (profileInput.current) profileInput.current.value = '';
    }, 'Profile import failed');

  const cdp = () =>
    run('cdp', async () => {
      if (cdpRunning) {
        const r = await api.post<ProfileResult>(`${base}/profile/cdp/stop`);
        setCdpRunning(false);
        toast.success(`Captured ${r?.functions ?? 0} functions`);
      } else {
        await api.post<OkResponse>(`${base}/profile/cdp/start`);
        setCdpRunning(true);
      }
    }, 'CDP profiling failed');

  return (
    <div className="control-layout">
      {/* Own grid so the sticky device panel stops at the end of this row instead of covering the feed below. */}
      <div className="control-top">
        <div className="control-left">
          <Card title="Device" subtitle={session.deviceModel ? `${session.deviceModel} · ${session.serial}` : session.serial}>
            <DeviceMirror sessionId={session.id} />
          </Card>
        </div>

        <div className="control-right">
          {activity ? (
            <div className="activity-banner" role="status">
              <Spinner size={14} />
              <span>{ACTIVITY_LABEL[activity] ?? activity}</span>
              <Button size="sm" variant="ghost" icon="cancel" onClick={() => void cancel()} loading={busy === 'cancel'}>
                Cancel
              </Button>
            </div>
          ) : null}

          <AgentStatus session={session} />

          <section className={`record-panel${recording ? ' live' : ''}`} aria-label="Recording">
            <div className="record-main">
              <Button variant="record" size="lg" className={recording ? 'recording' : ''} icon={recording ? 'stop' : 'record'} onClick={() => void toggleRecording()} loading={busy === 'record'}>
                {recording ? 'Stop recording' : 'Start recording'}
              </Button>
              <div className="record-stats">
                <div className="record-clock mono" aria-live="off">
                  {elapsed !== null ? fmtClock(elapsed) : '00:00'}
                </div>
                <div className="muted small">
                  {recording ? 'Recording' : session.status === 'stopped' ? 'Stopped' : 'Not recording'} · {fmtCompact(session.eventCount)} events
                </div>
              </div>
            </div>
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void addMark();
              }}
            >
              <label className="sr-only" htmlFor="mark-name">
                Mark name
              </label>
              <input id="mark-name" className="input input-sm" placeholder="Mark name (optional)" value={markName} maxLength={120} onChange={(e) => setMarkName(e.target.value)} />
              <Button size="sm" icon="flag" type="submit" loading={busy === 'mark'}>
                Add mark
              </Button>
            </form>
          </section>

          <Section title="App">
            <div className="btn-row">
              <Button icon="download" onClick={() => void install()} loading={busy === 'install'} disabled={blocked}>
                Install {session.variant}
              </Button>
              <Button icon="play" onClick={() => void launch()} loading={busy === 'launch'} disabled={blocked}>
                Cold launch
              </Button>
              <Button icon="bolt" onClick={() => void hotStart()} loading={busy === 'hot'} disabled={blocked}>
                Hot start
              </Button>
            </div>
            <Checkbox checked={grantPermissions} onChange={setGrantPermissions}>
              Grant runtime permissions on install
            </Checkbox>
            {lastLaunch ? (
              <p className="result-line">
                <Badge tone="accent">{lastLaunch.kind}</Badge> TTID <strong>{fmtMs(lastLaunch.totalTime)}</strong>
                {lastLaunch.waitTime !== null ? <span className="muted"> · wait {fmtMs(lastLaunch.waitTime)}</span> : null}
                {lastLaunch.launchState ? <span className="muted"> · {lastLaunch.launchState}</span> : null}
              </p>
            ) : null}
          </Section>

          <Section title="Startup benchmark" hint="Force-stops and relaunches the app repeatedly; results land on the Startup tab.">
            <div className="form-row">
              <label className="inline-field">
                <span>Iterations</span>
                <NumberInput label="Iterations" value={iterations} onChange={setIterations} min={1} max={10} />
              </label>
              <Checkbox checked={includeHot} onChange={setIncludeHot}>
                Include hot starts
              </Checkbox>
              <Button icon="gauge" onClick={() => void bench()} loading={busy === 'bench' || activity === 'benchmark'} disabled={blocked && activity !== 'benchmark'}>
                Run benchmark
              </Button>
            </div>
            {benchRuns ? (
              benchRuns.length ? (
                <table className="data-table dense">
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Kind</th>
                      <th scope="col" className="align-right">
                        TTID
                      </th>
                      <th scope="col" className="align-right">
                        Wait
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {benchRuns.map((r, i) => (
                      <tr key={i}>
                        <td className="num">{r.iteration ?? i + 1}</td>
                        <td>{r.kind}</td>
                        <td className="align-right num">{fmtMs(r.totalTime)}</td>
                        <td className="align-right num">{fmtMs(r.waitTime)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="muted small">No runs returned.</p>
              )
            ) : null}
          </Section>

          <Section title="Journeys" hint="Record taps/swipes made on the mirror and replay them for repeatable runs.">
            {session.journeyRecording ? (
              <div className="journey-live">
                <span className="rec-dot" aria-hidden="true" />
                <span>
                  Recording “{session.journeyRecording.name}” · {session.journeyRecording.steps} step{session.journeyRecording.steps === 1 ? '' : 's'}
                </span>
                <Button size="sm" variant="danger" icon="stop" onClick={() => void stopJourney()} loading={busy === 'journey'}>
                  Stop & save
                </Button>
              </div>
            ) : (
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void startJourney();
                }}
              >
                <label className="sr-only" htmlFor="journey-name">
                  Journey name
                </label>
                <input id="journey-name" className="input input-sm" placeholder="Journey name" value={journeyName} maxLength={120} onChange={(e) => setJourneyName(e.target.value)} />
                <Button size="sm" icon="record" type="submit" loading={busy === 'journey'} disabled={blocked}>
                  Record journey
                </Button>
              </form>
            )}
            {appJourneys.length === 0 ? (
              <p className="muted small">No journeys recorded for {session.packageName} yet.</p>
            ) : (
              <>
                <label className="inline-field">
                  <span>Repeat</span>
                  <NumberInput label="Replay repeat count" value={repeat} onChange={setRepeat} min={1} max={20} />
                </label>
                <ul className="journey-list">
                  {appJourneys.map((j) => (
                    <li key={j.id} className="journey-row">
                      <span className="journey-main">
                        <span className="strong truncate">{j.name}</span>
                        <span className="muted small">
                          {j.steps?.length ?? 0} steps · {fmtMs(journeyDuration(j))} · {fmtRelative(j.createdAt)}
                        </span>
                      </span>
                      <Button size="sm" icon="play" onClick={() => void replay(j)} disabled={blocked} loading={busy === 'replay'}>
                        Replay
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Section>

          <Section title="Auto-explore" hint="Taps through clickable elements to discover screens. Runs in the background.">
            <div className="form-row">
              <label className="inline-field">
                <span>Max steps</span>
                <NumberInput label="Max steps" value={maxSteps} onChange={setMaxSteps} min={1} max={500} />
              </label>
              <label className="inline-field">
                <span>Max seconds</span>
                <NumberInput label="Max duration in seconds" value={maxDuration} onChange={setMaxDuration} min={10} max={3600} />
              </label>
              <Button icon="compass" onClick={() => void explore()} loading={busy === 'explore' || activity === 'exploring'} disabled={blocked && activity !== 'exploring'}>
                Explore
              </Button>
            </div>
          </Section>

          <Section title="JS profiling" hint="Function-level CPU data. Import a Hermes .cpuprofile, or sample a debug build through Metro's inspector.">
            <div className="btn-row">
              <label className={`btn btn-default btn-md${busy === 'profile' ? ' disabled' : ''}`}>
                {busy === 'profile' ? <Spinner size={14} /> : <Icon name="file" size={16} />}
                <span className="btn-label">Import .cpuprofile</span>
                <input
                  ref={profileInput}
                  type="file"
                  accept=".cpuprofile,application/json"
                  className="sr-only"
                  disabled={busy === 'profile'}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void importProfile(f);
                  }}
                />
              </label>
              <Button icon={cdpRunning ? 'stop' : 'cpu'} onClick={() => void cdp()} loading={busy === 'cdp'} variant={cdpRunning ? 'danger' : 'default'}>
                {cdpRunning ? 'Stop CDP profile' : 'Start CDP profile'}
              </Button>
            </div>
          </Section>
        </div>
      </div>

      <div className="control-bottom">
        <LiveFeed events={stream.events} received={stream.received} onClear={stream.clear} connected={stream.connected} />
        <LogPanel logs={stream.logs} />
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }): ReactElement {
  return (
    <section className="control-section" aria-label={title}>
      <div className="control-section-head">
        <h3 className="subsection-title">{title}</h3>
        {hint ? <p className="muted small">{hint}</p> : null}
      </div>
      <div className="control-section-body">{children}</div>
    </section>
  );
}

function AgentStatus({ session }: { session: Session }): ReactElement {
  if (session.agentConnected) {
    return (
      <div className="agent-status ok">
        <Icon name="check" size={14} />
        <span>
          <strong>Agent connected</strong>
          {session.lastAgentEventAt ? <span className="muted"> · last event {fmtRelative(session.lastAgentEventAt)}</span> : null}
        </span>
      </div>
    );
  }
  if (session.hasAgentData && session.status !== 'recording') {
    return (
      <div className="agent-status ok">
        <Icon name="check" size={14} />
        <span>
          <strong>Agent data captured</strong>
          <span className="muted"> · the agent reconnects when the app runs during a recording</span>
        </span>
      </div>
    );
  }
  return (
    <div className="agent-status none">
      <Icon name="info" size={14} />
      <span>
        <strong>No agent events — native metrics only.</strong>{' '}
        <span className="muted">
          {session.variant === 'original'
            ? 'Use the instrumented build or integrate @rnpa/agent to capture screens, network and JS metrics.'
            : 'Install and launch the instrumented build; events appear once the app starts.'}
        </span>
      </span>
    </div>
  );
}

