import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { LIMITS, wireBatchSchema } from '@rnpa/shared';
import { detectToolchain, type Toolchain } from './android/sdk.js';
import { AppService } from './apps/service.js';
import { ensureDataDirs, type ServerConfig } from './config.js';
import { Store } from './db.js';
import { AppError } from './errors.js';
import { registerApiRoutes } from './routes/api.js';
import { bearer, createSecrets, registerSecurity, safeEqual, securityHeaders, type Secrets } from './security.js';
import { SessionManager } from './session/manager.js';

export interface Server {
  app: FastifyInstance;
  ingest: FastifyInstance | null;
  secrets: Secrets;
  tools: () => Toolchain;
  close(): Promise<void>;
}

function dashboardRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, 'public'), join(here, '..', '..', 'dashboard', 'dist')];
  return candidates.find((p) => existsSync(join(p, 'index.html'))) ?? null;
}

function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppError | Error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    }
    const status = (error as FastifyError).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const code = (error as FastifyError).code ?? 'BAD_REQUEST';
      const message = status === 413 ? 'Payload too large' : error.message;
      return reply.code(status).send({ error: { code, message } });
    }
    request.log.error({ err: error }, 'Unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Internal error — see the server log' } });
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } });
    return reply.code(404).type('text/plain').send('Not found');
  });
}

export async function createServer(config: ServerConfig): Promise<Server> {
  const paths = ensureDataDirs(config.dataDir);
  const store = new Store(paths.db);
  let tools = await detectToolchain();
  const getTools = () => tools;
  const secrets = createSecrets();
  const apps = new AppService(store, paths, getTools);
  const sessions = new SessionManager(store, getTools, apps.apkPathFor, config.metroUrl, config.ingestPort);

  const app = Fastify({
    logger: { level: process.env.RNPA_LOG_LEVEL ?? 'warn', redact: ['req.headers.authorization', 'req.headers.cookie', 'req.url'] },
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });
  installErrorHandler(app);
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: config.maxApkBytes, files: 1, fields: 4, parts: 5, headerPairs: 200 },
    throwFileSizeLimit: false,
  });
  registerSecurity(app, secrets, config.port, config.devOrigins);
  registerApiRoutes(app, { store, apps, sessions, config, secrets, tools: getTools, setTools: (t) => (tools = t) });

  const root = dashboardRoot();
  if (root) {
    await app.register(fastifyStatic, { root, index: 'index.html', wildcard: true, dotfiles: 'deny', serveDotFiles: false });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/plain').send('Dashboard is not built. Run `npm run build` in the repository root.'));
  }

  let ingest: FastifyInstance | null = null;
  if (config.ingestPort > 0) {
    ingest = Fastify({ logger: false, bodyLimit: LIMITS.maxBatchBytes, trustProxy: false });
    installErrorHandler(ingest);
    const ingestHosts = new Set([`127.0.0.1:${config.ingestPort}`, `localhost:${config.ingestPort}`]);
    ingest.addHook('onRequest', async (request, reply) => {
      securityHeaders(reply, "default-src 'none'");
      if (!ingestHosts.has(request.headers.host ?? '')) return reply.code(421).send({ error: { code: 'BAD_HOST', message: 'Unexpected Host' } });
      if (!safeEqual(bearer(request), secrets.ingestToken)) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Invalid ingest token' } });
      return undefined;
    });
    ingest.post('/ingest', async (request) => {
      const parsed = wireBatchSchema.safeParse(request.body);
      if (!parsed.success) throw new AppError(400, 'INVALID_BATCH', parsed.error.issues[0]?.message ?? 'Invalid batch');
      if (!sessions.routeBatch(parsed.data)) throw new AppError(409, 'NO_RECORDING', 'No recording session accepts this batch');
      return { ok: true };
    });
  }

  return {
    app,
    ingest,
    secrets,
    tools: getTools,
    async close() {
      await sessions.shutdown();
      await app.close();
      if (ingest) await ingest.close();
      store.close();
    },
  };
}
