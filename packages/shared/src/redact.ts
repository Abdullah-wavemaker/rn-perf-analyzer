/**
 * Privacy helpers. Network URLs routinely carry credentials (API keys, session
 * tokens, signed-URL signatures). They are redacted on the device before they
 * leave the app, and again on the host as defense in depth.
 *
 * Dependency-free and ES2017-safe: runs inside the instrumented app.
 */

const SENSITIVE_PARAM =
  /^(access[_-]?token|refresh[_-]?token|id[_-]?token|token|auth|authorization|api[_-]?key|apikey|key|secret|client[_-]?secret|password|passwd|pwd|session|sessionid|sid|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|code|otp|pin|ssn|email|phone)$/i;

export const MAX_URL_LENGTH = 2048;
export const REDACTED = '[redacted]';

/**
 * Removes user-info, redacts sensitive query parameters and fragments, and
 * caps the length. Never throws: malformed input is returned truncated.
 */
export function redactUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let url = raw.length > MAX_URL_LENGTH * 4 ? raw.slice(0, MAX_URL_LENGTH * 4) : raw;

  // Drop fragment entirely — it never reaches the server and often holds tokens (OAuth implicit flow).
  const hashAt = url.indexOf('#');
  if (hashAt !== -1) url = url.slice(0, hashAt);

  // Strip user:password@ from the authority.
  url = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, '$1');

  const queryAt = url.indexOf('?');
  if (queryAt !== -1) {
    const base = url.slice(0, queryAt);
    const query = url.slice(queryAt + 1);
    const parts = query.split('&').map((pair) => {
      const eq = pair.indexOf('=');
      const name = eq === -1 ? pair : pair.slice(0, eq);
      let decoded = name;
      try {
        decoded = decodeURIComponent(name);
      } catch {
        /* keep raw name */
      }
      return SENSITIVE_PARAM.test(decoded) && eq !== -1 ? `${name}=${REDACTED}` : pair;
    });
    url = `${base}?${parts.join('&')}`;
  }

  return url.length > MAX_URL_LENGTH ? `${url.slice(0, MAX_URL_LENGTH)}…` : url;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;
const HEXISH = /^[0-9a-f]{16,}$/i;
const OPAQUE = /^[A-Za-z0-9_-]{24,}$/;

/**
 * Collapses identifiers in a URL path so requests to the same endpoint group
 * together: `/users/42/orders/9f1c…` → `/users/:id/orders/:id`.
 * Query strings are dropped; the host is kept.
 */
export function endpointKey(method: string, url: string): string {
  const noQuery = url.split('?')[0] ?? url;
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/]+)?(.*)$/i.exec(noQuery);
  const origin = match?.[1] ?? '';
  const path = (match?.[2] ?? '')
    .split('/')
    .map((seg) => (NUMERIC.test(seg) || UUID.test(seg) || HEXISH.test(seg) || OPAQUE.test(seg) ? ':id' : seg))
    .join('/');
  return `${method.toUpperCase()} ${origin}${path || '/'}`;
}

/** Truncates arbitrary strings that end up in metadata (error messages, names). */
export function clampString(value: unknown, max = 512): string {
  const s = typeof value === 'string' ? value : String(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
