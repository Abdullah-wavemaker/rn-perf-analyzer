import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Local-only access control.
 *
 * Threats considered: other local users/processes, malicious web pages in the
 * developer's browser (CSRF, DNS rebinding), and apps on the connected device.
 *  - Launch token: random per run, printed once in the terminal. Exchanged at
 *    /auth for an HttpOnly, SameSite=Strict session cookie and removed from
 *    the URL by redirect. Also accepted as a Bearer token for scripts.
 *  - Host header allow-list blocks DNS rebinding.
 *  - State-changing requests need a custom header (forces a CORS preflight,
 *    which this server never approves) and a same-origin Origin if present.
 *  - The ingest endpoint for device agents lives on a separate listener with
 *    its own token and no access to the API.
 */

export const SESSION_COOKIE = 'rnpa_session';
export const CSRF_HEADER = 'x-rnpa-request';

export interface Secrets {
  launchToken: string;
  sessionSecret: string;
  ingestToken: string;
}

export function createSecrets(): Secrets {
  const fixed = process.env.RNPA_TOKEN;
  if (fixed !== undefined && !/^[A-Za-z0-9_-]{32,128}$/.test(fixed)) {
    throw new Error('RNPA_TOKEN must be 32–128 URL-safe characters');
  }
  return {
    launchToken: fixed ?? randomBytes(32).toString('base64url'),
    sessionSecret: randomBytes(32).toString('base64url'),
    ingestToken: randomBytes(32).toString('base64url'),
  };
}

export function safeEqual(a: string | undefined | null, b: string): boolean {
  if (typeof a !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

export function allowedOrigins(port: number, extra: string[]): Set<string> {
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`, ...extra]);
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(reply: FastifyReply, csp = CSP): void {
  reply.header('Content-Security-Policy', csp);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=(), payment=()');
}

export function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

function deny(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

export function registerSecurity(app: FastifyInstance, secrets: Secrets, port: number, devOrigins: string[]): void {
  const hosts = allowedHosts(port);
  const origins = allowedOrigins(port, devOrigins);

  app.addHook('onRequest', async (request, reply) => {
    securityHeaders(reply);

    const host = request.headers.host ?? '';
    if (!hosts.has(host)) return deny(reply, 421, 'BAD_HOST', 'Unexpected Host header');

    const url = request.url;
    if (url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');

    const mutating = request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS';
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== 'null' && !origins.has(origin)) {
      return deny(reply, 403, 'BAD_ORIGIN', 'Cross-origin requests are not allowed');
    }
    if (request.method === 'OPTIONS') return deny(reply, 403, 'NO_CORS', 'CORS is not supported');

    if (!url.startsWith('/api/')) return undefined;

    const cookie = request.cookies[SESSION_COOKIE];
    const authed = safeEqual(cookie, secrets.sessionSecret) || safeEqual(bearer(request), secrets.launchToken);
    if (!authed) return deny(reply, 401, 'UNAUTHENTICATED', 'Open the URL printed by `rnpa serve` to sign in');

    if (mutating && request.headers[CSRF_HEADER] !== '1') {
      return deny(reply, 403, 'CSRF', `Missing ${CSRF_HEADER} header`);
    }
    return undefined;
  });

  // One-time exchange of the launch token for a session cookie.
  app.get('/auth', async (request, reply) => {
    const token = (request.query as { token?: unknown }).token;
    if (typeof token !== 'string' || !safeEqual(token, secrets.launchToken)) {
      return deny(reply, 401, 'UNAUTHENTICATED', 'Invalid or expired link. Use the URL printed in the terminal.');
    }
    reply.setCookie(SESSION_COOKIE, secrets.sessionSecret, { httpOnly: true, sameSite: 'strict', path: '/', secure: false });
    return reply.redirect('/', 303);
  });
}
