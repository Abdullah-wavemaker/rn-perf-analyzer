import { useSyncExternalStore } from 'react';

export const SESSION_TABS = [
  'control',
  'overview',
  'startup',
  'screens',
  'network',
  'js',
  'rendering',
  'memory',
  'timeline',
] as const;
export type SessionTab = (typeof SESSION_TABS)[number];

export type Route =
  | { name: 'sessions' }
  | { name: 'apps'; appId: string | null }
  | { name: 'devices' }
  | { name: 'journeys' }
  | { name: 'session'; id: string; tab: SessionTab; query: URLSearchParams }
  | { name: 'notFound'; path: string };

function isTab(v: string | undefined): v is SessionTab {
  return v !== undefined && (SESSION_TABS as readonly string[]).includes(v);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const qIndex = raw.indexOf('?');
  const pathPart = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const query = new URLSearchParams(qIndex >= 0 ? raw.slice(qIndex + 1) : '');
  const parts = pathPart.split('/').filter(Boolean).map(safeDecode);

  if (parts.length === 0) return { name: 'sessions' };
  const [head, a, b] = parts;
  switch (head) {
    case 'sessions':
      if (!a) return { name: 'sessions' };
      return { name: 'session', id: a, tab: isTab(b) ? b : 'control', query };
    case 'apps':
      return { name: 'apps', appId: a ?? null };
    case 'devices':
      return { name: 'devices' };
    case 'journeys':
      return { name: 'journeys' };
    default:
      return { name: 'notFound', path: pathPart };
  }
}

/* Cache parsed route per hash so useSyncExternalStore gets a stable object. */
let cachedHash: string | null = null;
let cachedRoute: Route = { name: 'sessions' };

function getSnapshot(): Route {
  const h = window.location.hash;
  if (h !== cachedHash) {
    cachedHash = h;
    cachedRoute = parseHash(h);
  }
  return cachedRoute;
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  const target = path.startsWith('#') ? path : `#${path}`;
  if (opts.replace) {
    const url = new URL(window.location.href);
    url.hash = target;
    window.history.replaceState(null, '', url);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = target;
  }
}

export const paths = {
  sessions: () => '#/sessions',
  session: (id: string, tab: SessionTab = 'control', query?: Record<string, string>) => {
    const q = query ? `?${new URLSearchParams(query).toString()}` : '';
    return `#/sessions/${encodeURIComponent(id)}/${tab}${q}`;
  },
  apps: (id?: string) => (id ? `#/apps/${encodeURIComponent(id)}` : '#/apps'),
  devices: () => '#/devices',
  journeys: () => '#/journeys',
};
