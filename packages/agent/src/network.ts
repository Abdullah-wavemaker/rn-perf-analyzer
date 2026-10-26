import type { ApiClient } from '@rnpa/shared/events';
import { type AnyFn, nextId, now, originals, type XMLHttpRequestLike } from './env.js';
import { hookGlobal } from './hooks.js';
import type { Recorder } from './recorder.js';

/**
 * Network instrumentation for fetch, XMLHttpRequest and axios.
 *
 * React Native's `fetch` is the whatwg-fetch polyfill built on XHR, so a fetch
 * call creates an XHR synchronously. The fetch wrapper flags that XHR; the
 * XHR layer then only contributes byte counts and TTFB to the fetch event,
 * and nothing is double counted.
 *
 * Only metadata is captured — method, redacted URL, status, sizes, timings.
 * Request/response bodies and headers are never read or transmitted.
 */

interface XhrState {
  requestId: string;
  method: string;
  url: string;
  client: ApiClient;
  start: number;
  headersAt: number | null;
  failure: string | null;
  /** Set when the XHR backs a fetch() call. */
  fetchId: string | null;
}

interface XhrWithState extends XMLHttpRequestLike {
  __rnpa?: XhrState;
  status: number;
  responseType: string;
  response: unknown;
  responseText?: string;
  readyState: number;
  getResponseHeader(name: string): string | null;
  addEventListener(type: string, listener: () => void): void;
}

interface FetchExtras {
  responseSize?: number;
  ttfb?: number;
}

const AXIOS_DEFAULT_ACCEPT = 'application/json, text/plain, */*';
const PENDING_AXIOS_TTL_MS = 10000;

const fetchExtras: Record<string, FetchExtras> = {};
const pendingAxios: { method: string; url: string; at: number }[] = [];
let currentFetchId: string | null = null;

/** Registered by `instrumentAxios()` so XHRs issued by axios are labelled. */
export function registerAxiosRequest(method: string, url: string): void {
  const t = now();
  while (pendingAxios.length > 0 && t - (pendingAxios[0] as { at: number }).at > PENDING_AXIOS_TTL_MS) pendingAxios.shift();
  if (pendingAxios.length < 200) pendingAxios.push({ method: method.toUpperCase(), url, at: t });
}

function consumeAxiosMatch(method: string, url: string): boolean {
  for (let i = 0; i < pendingAxios.length; i++) {
    const p = pendingAxios[i] as { method: string; url: string };
    if (p.method === method && (p.url === url || (p.url.length > 1 && url.length > 1 && (url.indexOf(p.url) !== -1 || p.url.indexOf(url) !== -1)))) {
      pendingAxios.splice(i, 1);
      return true;
    }
  }
  return false;
}

function bodySize(body: unknown): number | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string') return body.length;
  const b = body as { size?: unknown; byteLength?: unknown };
  if (typeof b.size === 'number') return b.size;
  if (typeof b.byteLength === 'number') return b.byteLength;
  return undefined;
}

function xhrResponseSize(xhr: XhrWithState): number | undefined {
  try {
    const header = xhr.getResponseHeader('content-length');
    if (header && /^\d+$/.test(header)) return parseInt(header, 10);
    const type = xhr.responseType;
    if (type === '' || type === 'text') return typeof xhr.responseText === 'string' ? xhr.responseText.length : undefined;
    return bodySize(xhr.response);
  } catch {
    return undefined;
  }
}

export function installNetworkInstrumentation(recorder: Recorder): void {
  hookGlobal('XMLHttpRequest', function instrumentXhr(Original) {
    if (typeof Original !== 'function') return Original;
    originals.XMLHttpRequest = Original as unknown as { new (): XMLHttpRequestLike };
    const proto = (Original as { prototype: Record<string, AnyFn> }).prototype;
    const open = proto.open as AnyFn;
    const send = proto.send as AnyFn;
    const setRequestHeader = proto.setRequestHeader as AnyFn;

    proto.open = function rnpaOpen(this: XhrWithState, method: unknown, url: unknown) {
      if (!this.__rnpaInternal) {
        const m = String(method || 'GET').toUpperCase();
        const u = String(url || '');
        this.__rnpa = {
          requestId: currentFetchId || nextId('r'),
          method: m,
          url: u,
          client: consumeAxiosMatch(m, u) ? 'axios' : 'xhr',
          start: 0,
          headersAt: null,
          failure: null,
          fetchId: currentFetchId,
        };
      }
      // eslint-disable-next-line prefer-rest-params
      return open.apply(this, arguments as unknown as unknown[]);
    };

    proto.setRequestHeader = function rnpaSetRequestHeader(this: XhrWithState, name: unknown, value: unknown) {
      const state = this.__rnpa;
      if (state && state.client === 'xhr' && String(name).toLowerCase() === 'accept' && value === AXIOS_DEFAULT_ACCEPT) {
        state.client = 'axios';
      }
      // eslint-disable-next-line prefer-rest-params
      return setRequestHeader.apply(this, arguments as unknown as unknown[]);
    };

    proto.send = function rnpaSend(this: XhrWithState, body: unknown) {
      const state = this.__rnpa;
      if (state && !this.__rnpaInternal) {
        state.start = now();
        const xhr = this;
        const requestSize = bodySize(body);
        if (!state.fetchId) {
          recorder.emit('API_START', {
            requestId: state.requestId,
            method: state.method,
            url: state.url,
            client: state.client,
            requestSize,
          }, undefined, state.start);
        }
        try {
          xhr.addEventListener('readystatechange', function onReadyState() {
            if (xhr.readyState === 2 && state.headersAt === null) state.headersAt = now();
          });
          xhr.addEventListener('abort', function onAbort() {
            state.failure = 'aborted';
          });
          xhr.addEventListener('timeout', function onTimeout() {
            state.failure = 'timeout';
          });
          xhr.addEventListener('error', function onError() {
            state.failure = state.failure || 'network error';
          });
          xhr.addEventListener('loadend', function onLoadEnd() {
            const end = now();
            const responseSize = xhrResponseSize(xhr);
            const ttfb = state.headersAt !== null ? Math.round(state.headersAt - state.start) : undefined;
            if (state.fetchId) {
              fetchExtras[state.fetchId] = { responseSize, ttfb };
              return;
            }
            const status = xhr.status > 0 ? xhr.status : null;
            recorder.emit('API_END', {
              requestId: state.requestId,
              method: state.method,
              url: state.url,
              client: state.client,
              status,
              requestSize,
              responseSize,
              ttfb,
              error: status === null ? state.failure || 'network error' : undefined,
            }, end - state.start, end);
          });
        } catch {
          /* listener API missing — request still proceeds */
        }
      }
      // eslint-disable-next-line prefer-rest-params
      return send.apply(this, arguments as unknown as unknown[]);
    };
    return Original;
  });

  hookGlobal('fetch', function instrumentFetch(original) {
    if (typeof original !== 'function') return original;
    return function fetch(this: unknown, input: unknown, init?: { method?: string; body?: unknown }) {
      const req = input as { url?: string; method?: string } | string | null;
      const url = typeof req === 'string' ? req : req && typeof req.url === 'string' ? req.url : String(req);
      const method = String((init && init.method) || (req && typeof req === 'object' && req.method) || 'GET').toUpperCase();
      const requestId = nextId('f');
      const start = now();
      const meta = { requestId, method, url, client: 'fetch' as ApiClient, requestSize: bodySize(init && init.body) };
      recorder.emit('API_START', Object.assign({}, meta), undefined, start);

      let promise: Promise<{ status: number; headers?: { get?: (n: string) => string | null } }>;
      currentFetchId = requestId;
      try {
        // eslint-disable-next-line prefer-rest-params
        promise = (original as AnyFn).apply(this, arguments as unknown as unknown[]);
      } finally {
        currentFetchId = null;
      }
      return promise.then(
        function onResponse(response) {
          const end = now();
          const extras = fetchExtras[requestId] || {};
          delete fetchExtras[requestId];
          let responseSize = extras.responseSize;
          if (responseSize === undefined && response.headers && typeof response.headers.get === 'function') {
            const header = response.headers.get('content-length');
            if (header && /^\d+$/.test(header)) responseSize = parseInt(header, 10);
          }
          recorder.emit('API_END', Object.assign(meta, { status: response.status, responseSize, ttfb: extras.ttfb }), end - start, end);
          return response;
        },
        function onError(error: unknown) {
          const end = now();
          delete fetchExtras[requestId];
          const message = error && typeof (error as Error).message === 'string' ? (error as Error).message : 'network error';
          recorder.emit('API_END', Object.assign(meta, { status: null, error: message.slice(0, 200) }), end - start, end);
          throw error;
        },
      );
    };
  });
}

/** Minimal axios surface needed to tag requests; avoids a dependency on axios types. */
export interface AxiosLike {
  interceptors: { request: { use(onFulfilled: (config: AxiosConfigLike) => AxiosConfigLike): number } };
  getUri?: (config?: AxiosConfigLike) => string;
}

export interface AxiosConfigLike {
  method?: string;
  url?: string;
  baseURL?: string;
}

export function instrumentAxios(instance: AxiosLike): void {
  if (!instance || !instance.interceptors) return;
  instance.interceptors.request.use(function rnpaAxiosRequest(config) {
    try {
      let url = '';
      if (typeof instance.getUri === 'function') url = instance.getUri(config);
      if (!url) url = (config.baseURL || '').replace(/\/+$/, '') + '/' + (config.url || '').replace(/^\/+/, '');
      registerAxiosRequest(config.method || 'GET', url);
    } catch {
      /* never break the app's request */
    }
    return config;
  });
}
