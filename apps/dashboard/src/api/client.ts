/**
 * Single choke point for talking to @rnpa/server.
 *
 * - Same-origin cookies only (`credentials: 'same-origin'`).
 * - Every state-changing request carries `X-RNPA-Request: 1` (CSRF guard).
 * - Error bodies `{ error: { code, message } }` become an {@link ApiError}.
 * - A 401 anywhere flips the global auth state so the shell can show the
 *   "open the launch URL" screen.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/* ------------------------------ auth state ------------------------------ */

type AuthState = 'unknown' | 'ok' | 'unauthenticated';
let authState: AuthState = 'unknown';
const authListeners = new Set<() => void>();

function setAuthState(next: AuthState): void {
  if (authState === next) return;
  authState = next;
  for (const l of authListeners) l();
}

export const authStore = {
  get: (): AuthState => authState,
  subscribe(listener: () => void): () => void {
    authListeners.add(listener);
    return () => authListeners.delete(listener);
  },
  markUnauthenticated: (): void => setAuthState('unauthenticated'),
};

/* -------------------------------- helpers ------------------------------- */

const MUTATION_HEADER = 'X-RNPA-Request';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Pull `{ error: { code, message } }` out of an unknown body. */
export function parseErrorBody(status: number, body: unknown, fallback: string): ApiError {
  if (isRecord(body) && isRecord(body.error)) {
    const code = typeof body.error.code === 'string' ? body.error.code : `HTTP_${status}`;
    const message = typeof body.error.message === 'string' ? body.error.message : fallback;
    return new ApiError(status, code, message);
  }
  return new ApiError(status, `HTTP_${status}`, fallback);
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Raw body (Blob/File) instead of JSON; `contentType` sets its type. */
  rawBody?: BodyInit;
  contentType?: string;
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers[MUTATION_HEADER] = '1';

  let payload: BodyInit | undefined;
  if (opts.rawBody !== undefined) {
    payload = opts.rawBody;
    headers['Content-Type'] = opts.contentType ?? 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: payload,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', 'Cannot reach the RN Performance Analyzer server. Is `rnpa serve` still running?');
  }

  if (res.status === 401) {
    setAuthState('unauthenticated');
    throw new ApiError(401, 'UNAUTHENTICATED', 'Not authenticated');
  }
  const data = await readBody(res);
  if (!res.ok) throw parseErrorBody(res.status, data, `${method} ${path} failed (${res.status})`);
  setAuthState('ok');
  return data as T;
}

/** GET a binary resource (e.g. screenshot). */
async function getBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server');
  }
  if (res.status === 401) {
    setAuthState('unauthenticated');
    throw new ApiError(401, 'UNAUTHENTICATED', 'Not authenticated');
  }
  if (!res.ok) throw parseErrorBody(res.status, await readBody(res), `GET ${path} failed (${res.status})`);
  return res.blob();
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, body ?? {}, opts),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, body ?? {}, opts),
  del: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, undefined, opts),
  postRaw: <T>(path: string, rawBody: BodyInit, contentType: string) =>
    request<T>('POST', path, undefined, { rawBody, contentType }),
  getBlob,
};

/** URL-encode one path segment taken from data. */
export const seg = (s: string): string => encodeURIComponent(s);

/* ------------------------------ file upload ----------------------------- */

export interface UploadHandle<T> {
  promise: Promise<T>;
  abort: () => void;
}

/**
 * multipart upload with progress (fetch has no upload progress). Mirrors the
 * fetch wrapper's header and error rules.
 */
export function uploadFile<T>(path: string, field: string, file: File, onProgress: (fraction: number) => void): UploadHandle<T> {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<T>((resolve, reject) => {
    xhr.open('POST', path, true);
    xhr.withCredentials = false; // same-origin: cookies are sent regardless
    xhr.setRequestHeader(MUTATION_HEADER, '1');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.responseType = 'text';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'Upload failed: network error'));
    xhr.onabort = () => reject(new ApiError(0, 'ABORTED', 'Upload cancelled'));
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = xhr.responseText ? (JSON.parse(xhr.responseText) as unknown) : null;
      } catch {
        body = xhr.responseText;
      }
      if (xhr.status === 401) {
        setAuthState('unauthenticated');
        reject(new ApiError(401, 'UNAUTHENTICATED', 'Not authenticated'));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(parseErrorBody(xhr.status, body, `Upload failed (${xhr.status})`));
        return;
      }
      setAuthState('ok');
      resolve(body as T);
    };
    const form = new FormData();
    form.append(field, file, file.name);
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}
