import { chmodSync, existsSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { EventType, PerfEvent } from '@rnpa/shared';

/**
 * Local persistence on Node's built-in SQLite. Records (apps, sessions,
 * journeys) are stored as JSON documents; events get their own indexed table.
 * All statements are parameterized.
 */

export interface AppRecord {
  id: string;
  fileName: string;
  sha256: string;
  size: number;
  uploadedAt: number;
  packageName: string;
  versionName: string | null;
  versionCode: number | null;
  minSdk: number | null;
  targetSdk: number | null;
  launchActivity: string | null;
  debuggable: boolean;
  isReactNative: boolean;
  jsEngine: 'hermes' | 'jsc' | 'unknown';
  bundleFormat: 'hbc' | 'js' | 'none';
  bundleSize: number | null;
  devBundle: boolean;
  abis: string[];
  instrumented: {
    status: 'none' | 'running' | 'ready' | 'failed';
    strategy: 'bundle' | 'loader' | null;
    error: string | null;
    builtAt: number | null;
    channel: string | null;
  };
}

export interface SessionRecord {
  id: string;
  name: string;
  appId: string;
  packageName: string;
  serial: string;
  deviceModel: string | null;
  variant: 'original' | 'instrumented';
  createdAt: number;
  status: 'idle' | 'recording' | 'stopped';
  recordingStartedAt: number | null;
  recordingStoppedAt: number | null;
  eventCount: number;
}

export interface JourneyStep {
  kind: 'tap' | 'long_press' | 'swipe' | 'back';
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  durationMs?: number;
  delayMs: number;
  selector?: { resourceId?: string; text?: string; contentDesc?: string };
}

export interface JourneyRecord {
  id: string;
  name: string;
  packageName: string;
  createdAt: number;
  steps: JourneyStep[];
}

type Kind = 'apps' | 'sessions' | 'journeys';

export class Store {
  private readonly db: DatabaseSync;
  private readonly stmts: {
    insertEvent: StatementSync;
    maxSeq: StatementSync;
    countEvents: StatementSync;
  };

  constructor(path: string) {
    const fresh = !existsSync(path);
    this.db = new DatabaseSync(path);
    if (fresh) chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS apps (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journeys (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts REAL NOT NULL,
        type TEXT NOT NULL,
        screen TEXT,
        duration REAL,
        source TEXT NOT NULL,
        metadata TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS events_by_ts ON events (session_id, ts);
    `);
    this.stmts = {
      insertEvent: this.db.prepare(
        'INSERT INTO events (session_id, seq, ts, type, screen, duration, source, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      maxSeq: this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?'),
      countEvents: this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?'),
    };
  }

  close(): void {
    this.db.close();
  }

  /* ------------------------------ documents ----------------------------- */

  private put(kind: Kind, id: string, createdAt: number, data: object): void {
    this.db.prepare(`INSERT INTO ${kind} (id, created_at, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`).run(id, createdAt, JSON.stringify(data));
  }

  private get<T>(kind: Kind, id: string): T | null {
    const row = this.db.prepare(`SELECT data FROM ${kind} WHERE id = ?`).get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : null;
  }

  private list<T>(kind: Kind): T[] {
    const rows = this.db.prepare(`SELECT data FROM ${kind} ORDER BY created_at DESC`).all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as T);
  }

  private remove(kind: Kind, id: string): void {
    this.db.prepare(`DELETE FROM ${kind} WHERE id = ?`).run(id);
  }

  saveApp(app: AppRecord): void {
    this.put('apps', app.id, app.uploadedAt, app);
  }
  getApp(id: string): AppRecord | null {
    return this.get<AppRecord>('apps', id);
  }
  listApps(): AppRecord[] {
    return this.list<AppRecord>('apps');
  }
  deleteApp(id: string): void {
    this.remove('apps', id);
  }

  saveSession(session: SessionRecord): void {
    this.put('sessions', session.id, session.createdAt, session);
  }
  getSession(id: string): SessionRecord | null {
    return this.get<SessionRecord>('sessions', id);
  }
  listSessions(): SessionRecord[] {
    return this.list<SessionRecord>('sessions');
  }
  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM events WHERE session_id = ?').run(id);
    this.remove('sessions', id);
  }

  saveJourney(journey: JourneyRecord): void {
    this.put('journeys', journey.id, journey.createdAt, journey);
  }
  getJourney(id: string): JourneyRecord | null {
    return this.get<JourneyRecord>('journeys', id);
  }
  listJourneys(): JourneyRecord[] {
    return this.list<JourneyRecord>('journeys');
  }
  deleteJourney(id: string): void {
    this.remove('journeys', id);
  }

  /* -------------------------------- events ------------------------------ */

  nextSeq(sessionId: string): number {
    return (this.stmts.maxSeq.get(sessionId) as { seq: number }).seq + 1;
  }

  hasAgentEvents(sessionId: string): boolean {
    return this.db.prepare("SELECT 1 AS x FROM events WHERE session_id = ? AND source = 'agent' LIMIT 1").get(sessionId) !== undefined;
  }

  countEvents(sessionId: string): number {
    return (this.stmts.countEvents.get(sessionId) as { n: number }).n;
  }

  /** Inserts events in one transaction. `seq` is encoded in the id as `e<seq>`. */
  insertEvents(sessionId: string, events: PerfEvent[]): void {
    if (events.length === 0) return;
    this.db.exec('BEGIN');
    try {
      for (const e of events) {
        this.stmts.insertEvent.run(sessionId, Number.parseInt(e.id.slice(1), 10), e.ts, e.type, e.screen, e.duration, e.source, JSON.stringify(e.metadata));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  queryEvents(sessionId: string, filter: { types?: EventType[]; from?: number; to?: number; limit?: number } = {}): PerfEvent[] {
    const clauses = ['session_id = ?'];
    const params: (string | number)[] = [sessionId];
    if (filter.from !== undefined) {
      clauses.push('ts >= ?');
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      clauses.push('ts <= ?');
      params.push(filter.to);
    }
    if (filter.types && filter.types.length > 0) {
      clauses.push(`type IN (${filter.types.map(() => '?').join(', ')})`);
      params.push(...filter.types);
    }
    const limit = Math.min(Math.max(1, filter.limit ?? 2_000_000), 2_000_000);
    const rows = this.db
      .prepare(`SELECT seq, ts, type, screen, duration, source, metadata FROM events WHERE ${clauses.join(' AND ')} ORDER BY ts, seq LIMIT ${limit}`)
      .all(...params) as { seq: number; ts: number; type: EventType; screen: string | null; duration: number | null; source: PerfEvent['source']; metadata: string }[];
    return rows.map((r) => ({
      id: `e${r.seq}`,
      ts: r.ts,
      type: r.type,
      screen: r.screen,
      duration: r.duration,
      source: r.source,
      metadata: JSON.parse(r.metadata) as Record<string, unknown>,
    }));
  }
}
