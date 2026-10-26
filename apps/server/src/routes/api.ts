import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { EVENT_TYPES, type EventType } from '@rnpa/shared';
import { Adb, listAvds, listDevices, startAvd } from '../android/adb.js';
import { detectToolchain, requireTool, type Toolchain } from '../android/sdk.js';
import type { AppService } from '../apps/service.js';
import { VERSION, type ServerConfig } from '../config.js';
import type { SessionRecord, Store } from '../db.js';
import { AppError, badRequest, notFound } from '../errors.js';
import { renderReport, REPORT_CSP } from '../report/html.js';
import type { Secrets } from '../security.js';
import type { SessionManager } from '../session/manager.js';
import type { SessionView } from '../session/runtime.js';

export interface ApiContext {
  store: Store;
  apps: AppService;
  sessions: SessionManager;
  config: ServerConfig;
  secrets: Secrets;
  tools: () => Toolchain;
  setTools: (t: Toolchain) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function id(request: FastifyRequest, key = 'id'): string {
  const value = (request.params as Record<string, unknown>)[key];
  if (typeof value !== 'string' || !UUID.test(value)) throw notFound('Resource');
  return value;
}

function body<T extends z.ZodType>(schema: T, request: FastifyRequest): z.infer<T> {
  const result = schema.safeParse(request.body ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw badRequest(`${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`, 'VALIDATION');
  }
  return result.data;
}

const unit = z.number().finite().min(0).max(1);
const schemas = {
  createSession: z.object({
    appId: z.string().regex(UUID),
    serial: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    variant: z.enum(['original', 'instrumented']),
    name: z.string().trim().min(1).max(120).optional(),
  }),
  install: z.object({ replace: z.boolean().optional(), grantPermissions: z.boolean().optional() }),
  launch: z.object({ cold: z.boolean().optional() }),
  benchmark: z.object({ iterations: z.number().int().min(1).max(10), includeHot: z.boolean().optional() }),
  input: z.discriminatedUnion('kind', [
    z.object({ kind: z.enum(['tap', 'long_press']), x: unit, y: unit }),
    z.object({ kind: z.literal('swipe'), x: unit, y: unit, x2: unit, y2: unit, durationMs: z.number().int().min(50).max(5000).optional() }),
    z.object({ kind: z.enum(['back', 'home']) }),
  ]),
  mark: z.object({ name: z.string().trim().min(1).max(200) }),
  explore: z.object({ maxSteps: z.number().int().min(1).max(500).optional(), maxDurationSec: z.number().int().min(10).max(3600).optional() }),
  journeyStart: z.object({ name: z.string().trim().min(1).max(120) }),
  replay: z.object({ repeat: z.number().int().min(1).max(20).optional(), restart: z.boolean().optional() }),
};

function sessionView(ctx: ApiContext, record: SessionRecord): SessionView {
  return ctx.sessions.peek(record.id)?.view() ?? { ...record, activity: null, agentConnected: false, hasAgentData: ctx.store.hasAgentEvents(record.id), lastAgentEventAt: null, journeyRecording: null };
}

function sessionRecord(ctx: ApiContext, request: FastifyRequest): SessionRecord {
  const record = ctx.store.getSession(id(request));
  if (!record) throw notFound('Session');
  return record;
}

function attachmentName(base: string, ext: string): string {
  return `${base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}.${ext}`;
}

export function registerApiRoutes(app: FastifyInstance, ctx: ApiContext): void {
  /* ------------------------------ environment ------------------------------ */

  app.get('/api/env', async (request) => {
    const refresh = (request.query as { refresh?: string }).refresh === '1';
    if (refresh) ctx.setTools(await detectToolchain(true));
    const t = ctx.tools();
    return {
      version: VERSION,
      dataDir: ctx.config.dataDir,
      tools: { adb: t.adb, emulator: t.emulator, apksigner: t.apksigner, zipalign: t.zipalign, keytool: t.keytool, apktool: t.apktool },
      ingest: {
        enabled: ctx.config.ingestPort > 0,
        url: ctx.config.ingestPort > 0 ? `http://127.0.0.1:${ctx.config.ingestPort}/ingest` : '',
        token: ctx.config.ingestPort > 0 ? ctx.secrets.ingestToken : '',
      },
      metroInspectorUrl: ctx.config.metroUrl,
    };
  });

  app.get('/api/devices', async () => {
    const adbPath = requireTool(ctx.tools().adb, 'adb');
    const devices = await listDevices(adbPath);
    return Promise.all(devices.map((d) => new Adb(adbPath, d.serial).info(d.state)));
  });

  app.get('/api/avds', async () => {
    const t = ctx.tools();
    return t.emulator.available && t.emulator.path ? listAvds(t.emulator.path) : [];
  });

  app.post('/api/avds/:name/start', async (request) => {
    const name = (request.params as { name: string }).name;
    const avds = await listAvds(requireTool(ctx.tools().emulator, 'Android emulator'));
    if (!avds.includes(name)) throw notFound('AVD');
    startAvd(requireTool(ctx.tools().emulator, 'Android emulator'), name);
    return { ok: true };
  });

  /* ---------------------------------- apps --------------------------------- */

  app.post('/api/apps', async (request) => {
    const file = await request.file();
    if (!file || file.fieldname !== 'file') throw badRequest('Expected a multipart field named "file"');
    const record = await ctx.apps.upload(file.file, file.filename);
    return ctx.apps.view(record);
  });

  app.get('/api/apps', async () => ctx.store.listApps().map((a) => ctx.apps.view(a)));
  app.get('/api/apps/:id', async (request) => ctx.apps.view(ctx.apps.get(id(request))));
  app.delete('/api/apps/:id', async (request) => {
    await ctx.apps.delete(id(request));
    return { ok: true };
  });
  app.post('/api/apps/:id/instrument', async (request) => ctx.apps.view(ctx.apps.instrument(id(request))));

  /* -------------------------------- sessions ------------------------------- */

  app.post('/api/sessions', async (request) => {
    const input = body(schemas.createSession, request);
    const appRecord = ctx.apps.get(input.appId);
    if (input.variant === 'instrumented' && appRecord.instrumented.status !== 'ready') {
      throw new AppError(409, 'NOT_INSTRUMENTED', 'Build the instrumented APK first');
    }
    const adbPath = requireTool(ctx.tools().adb, 'adb');
    const device = (await listDevices(adbPath)).find((d) => d.serial === input.serial);
    if (!device || device.state !== 'device') throw new AppError(409, 'DEVICE_UNAVAILABLE', 'Device is not connected or not authorized');
    const info = await new Adb(adbPath, input.serial).info(device.state);
    const now = Date.now();
    const record: SessionRecord = {
      id: randomUUID(),
      name: input.name ?? `${appRecord.packageName} · ${new Date(now).toLocaleString()}`,
      appId: appRecord.id,
      packageName: appRecord.packageName,
      serial: input.serial,
      deviceModel: info.model,
      variant: input.variant,
      createdAt: now,
      status: 'idle',
      recordingStartedAt: null,
      recordingStoppedAt: null,
      eventCount: 0,
    };
    ctx.store.saveSession(record);
    return sessionView(ctx, record);
  });

  app.get('/api/sessions', async () => ctx.store.listSessions().map((s) => sessionView(ctx, s)));
  app.get('/api/sessions/:id', async (request) => sessionView(ctx, sessionRecord(ctx, request)));
  app.delete('/api/sessions/:id', async (request) => {
    await ctx.sessions.delete(sessionRecord(ctx, request).id);
    return { ok: true };
  });

  const runtimeOf = (request: FastifyRequest) => ctx.sessions.runtime(sessionRecord(ctx, request).id);

  app.post('/api/sessions/:id/install', async (request) => {
    await runtimeOf(request).install(body(schemas.install, request));
    return { ok: true };
  });
  app.post('/api/sessions/:id/launch', async (request) => runtimeOf(request).launch(body(schemas.launch, request).cold ?? true));
  app.post('/api/sessions/:id/hot-start', async (request) => runtimeOf(request).hotStart());
  app.post('/api/sessions/:id/startup-benchmark', async (request) => {
    const input = body(schemas.benchmark, request);
    return { runs: await runtimeOf(request).startupBenchmark(input.iterations, input.includeHot ?? true) };
  });
  app.post('/api/sessions/:id/record/start', async (request) => runtimeOf(request).startRecording());
  app.post('/api/sessions/:id/record/stop', async (request) => runtimeOf(request).stopRecording());
  app.post('/api/sessions/:id/input', async (request) => {
    await runtimeOf(request).input(body(schemas.input, request));
    return { ok: true };
  });
  app.post('/api/sessions/:id/marks', async (request) => {
    runtimeOf(request).mark(body(schemas.mark, request).name);
    return { ok: true };
  });
  app.post('/api/sessions/:id/cancel', async (request) => {
    runtimeOf(request).cancel();
    return { ok: true };
  });
  app.get('/api/sessions/:id/screenshot', async (request, reply) => {
    const png = await runtimeOf(request).screenshot();
    return reply.type('image/png').send(png);
  });
  app.get('/api/sessions/:id/ui', async (request) => {
    const snapshot = await runtimeOf(request).ui();
    return { ...snapshot, nodes: snapshot.nodes.map(({ packageName: _p, enabled: _e, ...n }) => n) };
  });
  app.post('/api/sessions/:id/explore', async (request) => {
    const input = body(schemas.explore, request);
    runtimeOf(request).startExploration(input.maxSteps ?? 60, input.maxDurationSec ?? 300);
    return { ok: true };
  });

  app.get('/api/sessions/:id/events', async (request) => {
    const record = sessionRecord(ctx, request);
    const q = request.query as Record<string, string | undefined>;
    const types = q.types
      ? q.types.split(',').map((t) => {
          if (!(EVENT_TYPES as readonly string[]).includes(t)) throw badRequest(`Unknown event type ${t}`);
          return t as EventType;
        })
      : undefined;
    const num = (v: string | undefined) => {
      if (v === undefined || v === '') return undefined;
      const n = Number(v);
      if (!Number.isFinite(n)) throw badRequest('Invalid number in query');
      return n;
    };
    return ctx.store.queryEvents(record.id, { types, from: num(q.from), to: num(q.to), limit: num(q.limit) });
  });

  app.get('/api/sessions/:id/analysis', async (request) => ctx.sessions.analysis(sessionRecord(ctx, request).id));

  app.get('/api/sessions/:id/export.json', async (request, reply) => {
    const record = sessionRecord(ctx, request);
    const appRecord = ctx.apps.get(record.appId);
    reply.header('Content-Disposition', `attachment; filename="${attachmentName(`rnpa-${record.packageName}-${record.id.slice(0, 8)}`, 'json')}"`);
    return {
      exportedAt: Date.now(),
      session: record,
      app: ctx.apps.view(appRecord),
      events: ctx.store.queryEvents(record.id),
      analysis: ctx.sessions.analysis(record.id),
    };
  });

  app.get('/api/sessions/:id/report.html', async (request, reply) => {
    const record = sessionRecord(ctx, request);
    const html = renderReport(record, ctx.apps.get(record.appId), ctx.sessions.analysis(record.id));
    reply.header('Content-Security-Policy', REPORT_CSP);
    reply.header('Content-Disposition', `inline; filename="${attachmentName(`rnpa-report-${record.packageName}`, 'html')}"`);
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.post(
    '/api/sessions/:id/profile',
    { bodyLimit: ctx.config.maxProfileBytes },
    async (request) => {
      const anchor = Number((request.query as { anchor?: string }).anchor);
      return { functions: runtimeOf(request).importProfile(request.body, Number.isFinite(anchor) && anchor > 0 ? anchor : undefined) };
    },
  );
  app.post('/api/sessions/:id/profile/cdp/start', async (request) => {
    await runtimeOf(request).startCdpProfiling();
    return { ok: true };
  });
  app.post('/api/sessions/:id/profile/cdp/stop', async (request) => ({ functions: await runtimeOf(request).stopCdpProfiling() }));

  app.get('/api/sessions/:id/stream', (request: FastifyRequest, reply: FastifyReply) => {
    const runtime = runtimeOf(request);
    const headers = { ...reply.getHeaders() } as Record<string, string>;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const write = (event: string, data: unknown) => {
      if (res.writableLength > 8 * 1024 * 1024) {
        res.destroy();
        return;
      }
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const unsubscribe = runtime.subscribe((m) => write(m.event, m.data));
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    request.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  /* -------------------------------- journeys ------------------------------- */

  app.get('/api/journeys', async () => ctx.store.listJourneys());
  app.delete('/api/journeys/:id', async (request) => {
    const journeyId = id(request);
    if (!ctx.store.getJourney(journeyId)) throw notFound('Journey');
    ctx.store.deleteJourney(journeyId);
    return { ok: true };
  });
  app.post('/api/sessions/:id/journey-recording/start', async (request) => runtimeOf(request).startJourneyRecording(body(schemas.journeyStart, request).name));
  app.post('/api/sessions/:id/journey-recording/stop', async (request) => runtimeOf(request).stopJourneyRecording());
  app.post('/api/sessions/:id/journeys/:journeyId/replay', async (request) => {
    const journey = ctx.store.getJourney(id(request, 'journeyId'));
    if (!journey) throw notFound('Journey');
    const input = body(schemas.replay, request);
    runtimeOf(request).replayJourney(journey, input.repeat ?? 1, input.restart ?? true);
    return { ok: true };
  });
}
